import { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  type AudioPlayer,
  type AudioPlayerState,
  type AudioResource,
  type VoiceConnection,
  type VoiceConnectionState,
} from '@discordjs/voice';
import type { GuildMember, VoiceBasedChannel } from 'discord.js';
import type { Logger } from '../logging/logger.js';
import { describeError } from '../logging/logger.js';
import type { MusicOutput } from '../music/types.js';
import type { SpeechToText, TextToSpeech } from '../speech/ports.js';
import type { UsageMeter } from '../usage/UsageService.js';
import type { Clock } from '../util/time.js';
import { MusicArbiter, type PausablePlayer, type PlayerStatus } from './MusicArbiter.js';
import { captureUtterance, type CaptureOptions, type CapturedUtterance } from './SpeechCapture.js';
import { openReplySpeech, type ReplySpeech } from './ReplySpeech.js';
import { SpeechQueue } from './SpeechQueue.js';

export interface VoiceSessionDeps {
  logger: Logger;
  stt: SpeechToText;
  tts: TextToSpeech;
  clock: Clock;
  capture: CaptureOptions;
  /**
   * Decides, each time someone starts talking, whether their audio may be transcribed (their
   * privacy choice, the daily budget). When it says no, nothing is captured or sent anywhere.
   */
  admitSpeaker: (guildId: string, userId: string) => boolean | Promise<boolean>;
  meter: UsageMeter;
}

/** Audio ready to play, or to throw away if it was cancelled while being prepared. */
interface PreparedAudio {
  toResource(): AudioResource;
  discard(): void;
}

/** What a listening session reports. Only `utterance` is required. */
export interface VoiceListener {
  /** Someone finished saying something and it has been transcribed. */
  utterance(utterance: CapturedUtterance): void;
  /** Someone is talking right now; `audioMs` is how much their current utterance holds so far. */
  speaking?(userId: string, audioMs: number): void;
  /** What someone has said so far, before they have finished. */
  partial?(userId: string, text: string): void;
  /** Someone stopped being listened to. `heard` is false when nothing came of it (noise, or nothing intelligible). */
  captureEnded?(userId: string, heard: boolean): void;
}

const SPEECH_TIMEOUT_MS = 2 * 60_000;
const RECONNECT_GRACE_MS = 5_000;
/** Polly accepts at most this many characters per request. */
const MAX_SPEECH_CHARACTERS = 3_000;

/**
 * One guild's voice connection: speech in (per-person utterance capture), the assistant's audio out
 * (replies and its chime) and music out. A connection plays one audio player at a time, so the
 * assistant's audio temporarily takes over from music, and MusicArbiter decides when music resumes.
 */
export class VoiceSession {
  readonly guildId: string;
  private currentChannel: VoiceBasedChannel;
  private readonly musicPlayer: AudioPlayer;
  private readonly speechPlayer: AudioPlayer;
  private readonly arbiter: MusicArbiter;

  /** Transcript session id while listening, undefined otherwise. */
  transcriptSessionId: number | undefined;

  private speakingListener: ((userId: string) => void) | undefined;
  /** People being listened to right now, with a way to stop listening to each. */
  private readonly activeCaptures = new Map<string, AbortController>();

  private readonly speech: SpeechQueue<PreparedAudio>;
  private speechActive = false;

  private destroyed = false;
  private readonly destroyedListeners: Array<() => void> = [];

  readonly music: MusicOutput;

  constructor(
    readonly connection: VoiceConnection,
    channel: VoiceBasedChannel,
    private readonly deps: VoiceSessionDeps,
  ) {
    this.guildId = channel.guild.id;
    this.currentChannel = channel;
    // Pause (don't keep consuming the stream) when no connection is listening to this player.
    this.musicPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.speechPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.musicPlayer.on('error', (error) => deps.logger.warn(`Music player error: ${describeError(error)}`));
    this.speechPlayer.on('error', (error) => deps.logger.warn(`Speech player error: ${describeError(error)}`));
    this.arbiter = new MusicArbiter(pausable(this.musicPlayer));
    this.speech = new SpeechQueue<PreparedAudio>(
      {
        play: (audio) => this.playSpeech(audio),
        stop: () => this.speechPlayer.stop(true),
        discard: (audio) => audio.discard(),
        pause: () => this.speechPlayer.pause(true),
        resume: () => this.speechPlayer.unpause(),
      },
      { started: () => this.beginSpeech(), idle: () => this.endSpeech() },
      deps.logger,
    );
    connection.subscribe(this.musicPlayer);
    connection.on('stateChange', (oldState, newState) => void this.onConnectionStateChange(oldState, newState));
    connection.on('error', (error) => deps.logger.warn(`Voice connection error: ${describeError(error)}`));
    this.music = this.createMusicOutput();
  }

  get channel(): VoiceBasedChannel {
    return this.currentChannel;
  }

  get channelId(): string {
    return this.currentChannel.id;
  }

  get listening(): boolean {
    return this.speakingListener !== undefined;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** The people (not bots) currently in the channel, by name. */
  presentMembers(): Array<{ id: string; name: string }> {
    return [...this.currentChannel.members.values()]
      .filter((member) => !member.user.bot)
      .map((member) => ({ id: member.id, name: member.displayName }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * How many people (not bots) are in the channel. Counted from voice states, so someone whose
   * member record isn't cached still counts.
   */
  humansPresent(): number {
    let count = 0;
    for (const state of this.currentChannel.guild.voiceStates.cache.values()) {
      if (state.channelId !== this.currentChannel.id) continue;
      if (state.member?.user.bot) continue;
      count++;
    }
    return count;
  }

  async resolveMember(userId: string): Promise<GuildMember | undefined> {
    const guild = this.currentChannel.guild;
    const cached = guild.members.cache.get(userId);
    if (cached) return cached;
    try {
      return await guild.members.fetch(userId);
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Channel / connection
  // -------------------------------------------------------------------------

  /** Moves to another channel (or re-joins the same one) with the given deafen state. */
  async moveTo(channel: VoiceBasedChannel, selfDeaf: boolean): Promise<void> {
    this.currentChannel = channel;
    this.connection.rejoin({ channelId: channel.id, selfDeaf, selfMute: false });
    await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
  }

  /** Records that someone else moved the bot to `channel` (the connection follows on its own). */
  adoptChannel(channel: VoiceBasedChannel): void {
    this.currentChannel = channel;
  }

  onDestroyed(listener: () => void): void {
    if (this.destroyed) listener();
    else this.destroyedListeners.push(listener);
  }

  destroy(): void {
    if (this.destroyed) return;
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    } else {
      this.handleDestroyed();
    }
  }

  private async onConnectionStateChange(_old: VoiceConnectionState, state: VoiceConnectionState): Promise<void> {
    if (state.status === VoiceConnectionStatus.Disconnected) {
      // Either a channel move/region change (reconnects on its own) or a real disconnect.
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, RECONNECT_GRACE_MS),
          entersState(this.connection, VoiceConnectionStatus.Connecting, RECONNECT_GRACE_MS),
        ]);
      } catch {
        if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
      }
    } else if (state.status === VoiceConnectionStatus.Destroyed) {
      this.handleDestroyed();
    }
  }

  private handleDestroyed(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopListening();
    this.speech.stopAll();
    this.musicPlayer.stop(true);
    this.speechPlayer.stop(true);
    for (const listener of this.destroyedListeners.splice(0)) {
      try {
        listener();
      } catch (error) {
        this.deps.logger.warn(`Voice session destroy listener failed: ${describeError(error)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Speech in
  // -------------------------------------------------------------------------

  /** Starts capturing each person's speech; `listener` hears about it as it happens. */
  startListening(listener: VoiceListener): void {
    if (this.speakingListener) return;
    const onStart = (userId: string) => {
      if (this.activeCaptures.has(userId) || this.destroyed) return;
      const member = this.currentChannel.guild.members.cache.get(userId);
      if (member?.user.bot) return;
      // Claim the slot before the (usually instant) admission check so a second 'start' can't race it.
      const controller = new AbortController();
      this.activeCaptures.set(userId, controller);
      void this.capture(userId, controller, listener);
    };
    this.speakingListener = onStart;
    this.connection.receiver.speaking.on('start', onStart);
  }

  stopListening(): void {
    if (!this.speakingListener) return;
    this.connection.receiver.speaking.off('start', this.speakingListener);
    this.speakingListener = undefined;
    for (const controller of this.activeCaptures.values()) controller.abort();
  }

  /** Stops transcribing what `userId` is saying right now (their audio stops being sent at once). */
  cancelCapture(userId: string): void {
    this.activeCaptures.get(userId)?.abort();
  }

  private async capture(userId: string, controller: AbortController, listener: VoiceListener): Promise<void> {
    let heard = false;
    const live = () => !this.destroyed && !controller.signal.aborted;
    try {
      if (!(await this.deps.admitSpeaker(this.guildId, userId))) return;
      if (!live()) return;
      const utterance = await captureUtterance({
        receiver: this.connection.receiver,
        userId,
        stt: this.deps.stt,
        options: this.deps.capture,
        clock: this.deps.clock,
        logger: this.deps.logger,
        signal: controller.signal,
        onAudioSent: (seconds) => this.deps.meter.recordTranscription(this.guildId, seconds),
        onAudio: (audioMs) => {
          if (live()) this.notify(() => listener.speaking?.(userId, audioMs));
        },
        onPartial: (text) => {
          if (live()) this.notify(() => listener.partial?.(userId, text));
        },
      });
      if (utterance && live()) {
        heard = true;
        listener.utterance(utterance);
      }
    } catch (error) {
      this.deps.logger.warn(`Speech capture failed for ${userId}: ${describeError(error)}`);
    } finally {
      if (this.activeCaptures.get(userId) === controller) this.activeCaptures.delete(userId);
      if (!this.destroyed) this.notify(() => listener.captureEnded?.(userId, heard));
    }
  }

  /** A listener that throws must not break the capture that called it. */
  private notify(call: () => void): void {
    try {
      call();
    } catch (error) {
      this.deps.logger.warn(`A voice listener failed: ${describeError(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Assistant audio out
  // -------------------------------------------------------------------------

  /**
   * Keeps music paused until the returned function is called. Taken when the assistant hears its
   * name, so music stays quiet through the chime, the thinking and the reply.
   */
  holdMusic(): () => void {
    return this.arbiter.hold();
  }

  /**
   * Plays a short sound (48 kHz 16-bit stereo PCM) right away. Skipped, returning false, if the
   * assistant is already talking: a cue that waits behind other speech would arrive too late.
   */
  playEarcon(pcm: Buffer): boolean {
    if (this.destroyed || this.speech.busy) return false;
    void this.speech.enqueue('a sound', async () => ({
      toResource: () => createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw }),
      discard: () => undefined,
    }));
    return true;
  }

  /** Speaks `text` after anything already queued. Resolves when it has finished playing (or was cancelled). */
  speak(text: string): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    return this.speech.enqueue('a reply', () => this.synthesize(text));
  }

  /**
   * Starts a reply that is spoken piece by piece as it's written. Each piece is synthesised while
   * the one before it plays.
   */
  openReply(): ReplySpeech {
    return openReplySpeech(this.speech, (text) => this.synthesize(text), () => !this.destroyed);
  }

  /** Stops the current utterance and drops anything queued. Returns whether it was talking. */
  stopSpeaking(): boolean {
    return this.speech.stopAll();
  }

  /** Freezes speech mid-word (someone has started talking over it) until resumeSpeaking(). */
  pauseSpeaking(): void {
    this.speech.pause();
  }

  resumeSpeaking(): void {
    this.speech.resume();
  }

  get speechPaused(): boolean {
    return this.speech.paused;
  }

  /**
   * Says a few words next, ahead of anything waiting: a short "one moment" while a reply is playing.
   * Resolves true once they have been said, false if they never were (everything was stopped first).
   */
  async interject(text: string): Promise<boolean> {
    if (this.destroyed) return false;
    let said = false;
    await this.speech.enqueueNext('an acknowledgement', () => this.synthesize(text), {
      started: () => {
        said = true;
      },
    });
    return said;
  }

  private async synthesize(text: string): Promise<PreparedAudio> {
    const input = text.slice(0, MAX_SPEECH_CHARACTERS);
    this.deps.meter.recordSpeech(this.guildId, input.length);
    const speech = await this.deps.tts.synthesize(input);
    return {
      toResource: () => createAudioResource(speech.audio, { inputType: StreamType.Arbitrary }),
      discard: () => speech.audio.destroy(),
    };
  }

  private async playSpeech(audio: PreparedAudio): Promise<void> {
    if (this.destroyed) {
      audio.discard();
      return;
    }
    this.speechPlayer.play(audio.toResource());
    await entersState(this.speechPlayer, AudioPlayerStatus.Idle, SPEECH_TIMEOUT_MS).catch(() => this.speechPlayer.stop(true));
  }

  private beginSpeech(): void {
    if (this.speechActive) return;
    this.speechActive = true;
    this.arbiter.speechStarted();
    this.connection.subscribe(this.speechPlayer);
  }

  private endSpeech(): void {
    if (!this.speechActive) return;
    this.speechActive = false;
    if (this.destroyed) return;
    this.connection.subscribe(this.musicPlayer);
    this.arbiter.speechEnded();
  }

  // -------------------------------------------------------------------------
  // Music out
  // -------------------------------------------------------------------------

  private createMusicOutput(): MusicOutput {
    const player = this.musicPlayer;
    const arbiter = this.arbiter;
    return {
      get state() {
        return arbiter.reportedState();
      },
      play(stream: Readable) {
        arbiter.trackChanged();
        player.play(createAudioResource(stream, { inputType: StreamType.Arbitrary }));
      },
      stop() {
        arbiter.trackChanged();
        player.stop(true);
      },
      pause() {
        return arbiter.userPause();
      },
      resume() {
        return arbiter.userResume();
      },
      onIdle(listener: () => void) {
        const handler = (oldState: AudioPlayerState, newState: AudioPlayerState) => {
          if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) listener();
        };
        player.on('stateChange', handler);
        return () => player.off('stateChange', handler);
      },
      onError(listener: (error: Error) => void) {
        player.on('error', listener);
        return () => player.off('error', listener);
      },
    };
  }
}

/** Adapts a @discordjs/voice AudioPlayer to what MusicArbiter needs. */
function pausable(player: AudioPlayer): PausablePlayer {
  const statuses: Record<AudioPlayerStatus, PlayerStatus> = {
    [AudioPlayerStatus.Idle]: 'idle',
    [AudioPlayerStatus.Buffering]: 'buffering',
    [AudioPlayerStatus.Playing]: 'playing',
    [AudioPlayerStatus.Paused]: 'paused',
    [AudioPlayerStatus.AutoPaused]: 'autopaused',
  };
  return {
    get status() {
      return statuses[player.state.status];
    },
    pause: () => player.pause(true),
    unpause: () => player.unpause(),
  };
}
