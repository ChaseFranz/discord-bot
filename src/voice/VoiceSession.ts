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
import type { Clock } from '../util/time.js';
import { MusicArbiter, type PausablePlayer, type PlayerStatus } from './MusicArbiter.js';
import { captureUtterance, type CaptureOptions, type CapturedUtterance } from './SpeechCapture.js';

export interface VoiceSessionDeps {
  logger: Logger;
  stt: SpeechToText;
  tts: TextToSpeech;
  clock: Clock;
  capture: CaptureOptions;
}

/** Audio ready to play, or to throw away if it was cancelled while being prepared. */
interface PreparedAudio {
  toResource(): AudioResource;
  discard(): void;
}

const SPEECH_TIMEOUT_MS = 2 * 60_000;
const RECONNECT_GRACE_MS = 5_000;

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
  private readonly activeCaptures = new Set<string>();

  private speechQueueDepth = 0;
  private speechChain: Promise<void> = Promise.resolve();
  private speechGeneration = 0;
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
    this.speechGeneration++;
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

  /** Starts capturing each person's speech; `onUtterance` gets every transcribed utterance. */
  startListening(onUtterance: (utterance: CapturedUtterance) => void): void {
    if (this.speakingListener) return;
    const listener = (userId: string) => {
      if (this.activeCaptures.has(userId) || this.destroyed) return;
      const member = this.currentChannel.guild.members.cache.get(userId);
      if (member?.user.bot) return;
      this.activeCaptures.add(userId);
      captureUtterance(this.connection.receiver, userId, this.deps.stt, this.deps.capture, this.deps.clock, this.deps.logger)
        .then((utterance) => {
          if (utterance && !this.destroyed) onUtterance(utterance);
        })
        .catch((error: unknown) => this.deps.logger.warn(`Speech capture failed for ${userId}: ${describeError(error)}`))
        .finally(() => this.activeCaptures.delete(userId));
    };
    this.speakingListener = listener;
    this.connection.receiver.speaking.on('start', listener);
  }

  stopListening(): void {
    if (!this.speakingListener) return;
    this.connection.receiver.speaking.off('start', this.speakingListener);
    this.speakingListener = undefined;
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
    if (this.destroyed || this.speechActive || this.speechQueueDepth > 0) return false;
    void this.enqueueAudio('a sound', async () => ({
      toResource: () => createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw }),
      discard: () => undefined,
    }));
    return true;
  }

  /** Speaks `text` after anything already queued. Resolves when it has finished playing (or was cancelled). */
  speak(text: string): Promise<void> {
    return this.enqueueAudio('a reply', async () => {
      const speech = await this.deps.tts.synthesize(text);
      return {
        toResource: () => createAudioResource(speech.audio, { inputType: StreamType.Arbitrary }),
        discard: () => speech.audio.destroy(),
      };
    });
  }

  /** Stops the current utterance and drops anything queued. */
  stopSpeaking(): boolean {
    const wasSpeaking = this.speechActive || this.speechQueueDepth > 0;
    this.speechGeneration++;
    this.speechPlayer.stop(true);
    return wasSpeaking;
  }

  private enqueueAudio(what: string, prepare: () => Promise<PreparedAudio>): Promise<void> {
    const generation = this.speechGeneration;
    this.speechQueueDepth++;
    const run = async () => {
      try {
        if (generation !== this.speechGeneration || this.destroyed) return;
        const audio = await prepare();
        if (generation !== this.speechGeneration || this.destroyed) {
          audio.discard();
          return;
        }
        this.beginSpeech();
        this.speechPlayer.play(audio.toResource());
        await entersState(this.speechPlayer, AudioPlayerStatus.Idle, SPEECH_TIMEOUT_MS).catch(() => this.speechPlayer.stop(true));
      } catch (error) {
        this.deps.logger.warn(`Could not play ${what}: ${describeError(error)}`);
      } finally {
        this.speechQueueDepth--;
        if (this.speechQueueDepth === 0) this.endSpeech();
      }
    };
    this.speechChain = this.speechChain.then(run);
    return this.speechChain;
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
