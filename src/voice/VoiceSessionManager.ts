import { VoiceConnectionStatus, entersState, joinVoiceChannel } from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import type { Logger } from '../logging/logger.js';
import { describeError } from '../logging/logger.js';
import { MusicError, type MusicHost, type MusicOutput } from '../music/types.js';
import type { TranscriptRepository, VoiceSessionRecord } from '../storage/ports.js';
import type { Schedule } from '../util/schedule.js';
import type { CapturedUtterance } from './SpeechCapture.js';
import { VoiceSession, type VoiceSessionDeps } from './VoiceSession.js';

export type UtteranceHandler = (session: VoiceSession, utterance: CapturedUtterance) => Promise<void>;
export type ChannelResolver = (guildId: string, channelId: string) => Promise<VoiceBasedChannel | null>;

export interface VoiceSessionManagerDeps extends VoiceSessionDeps {
  transcripts: TranscriptRepository;
  resolveChannel: ChannelResolver;
  /** The bot's own Discord user id. */
  botUserId: () => string;
  /** Leave a channel after it has had nobody but bots in it for this long; 0 never leaves on its own. */
  autoLeaveMs: number;
  schedule: Schedule;
}

/** A change to someone's voice state (joined, left or moved channel), as the manager needs it. */
export interface VoiceStateChange {
  guildId: string;
  userId: string;
  oldChannelId: string | null;
  newChannelId: string | null;
  /** The channel they're in now, when they're in one. */
  newChannel: VoiceBasedChannel | null;
}

const READY_TIMEOUT_MS = 30_000;

/** Owns at most one VoiceSession per guild and decides when to join, move and leave. */
export class VoiceSessionManager implements MusicHost {
  private readonly sessions = new Map<string, VoiceSession>();
  private utteranceHandler: UtteranceHandler | undefined;
  private readonly endedListeners: Array<(guildId: string) => void> = [];
  private readonly transcriptEndedListeners: Array<(record: VoiceSessionRecord) => void> = [];
  /** Pending auto-leave per guild, while the bot is alone in its channel. */
  private readonly aloneTimers = new Map<string, () => void>();

  constructor(private readonly deps: VoiceSessionManagerDeps) {}

  /** Receives every transcribed utterance while a session is listening. */
  setUtteranceHandler(handler: UtteranceHandler): void {
    this.utteranceHandler = handler;
  }

  /** Called with the guild id whenever a session ends (left, kicked, or disconnected). */
  onSessionEnded(listener: (guildId: string) => void): void {
    this.endedListeners.push(listener);
  }

  /** Called when a stretch of listening (a transcript session) ends, e.g. to write a recap. */
  onTranscriptEnded(listener: (record: VoiceSessionRecord) => void): void {
    this.transcriptEndedListeners.push(listener);
  }

  /** Every session that is still connected. */
  all(): VoiceSession[] {
    return [...this.sessions.values()].filter((session) => !session.isDestroyed);
  }

  get(guildId: string): VoiceSession | undefined {
    const session = this.sessions.get(guildId);
    return session && !session.isDestroyed ? session : undefined;
  }

  /**
   * Joins (or moves to) `channel`. With `listen`, the bot un-deafens, starts a transcript
   * session and transcribes what people say.
   */
  async join(channel: VoiceBasedChannel, options: { listen: boolean }): Promise<VoiceSession> {
    const existing = this.get(channel.guild.id);
    if (existing) {
      const listen = options.listen || existing.listening;
      const moving = existing.channelId !== channel.id;
      if (moving && existing.listening) await this.stopListening(existing);
      if (moving || (listen && !existing.listening)) {
        await existing.moveTo(channel, !listen);
      }
      if (listen && !existing.listening) await this.startListening(existing);
      this.checkOccupancy(existing);
      return existing;
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: !options.listen,
      selfMute: false,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    } catch (error) {
      connection.destroy();
      throw new Error(`Could not connect to #${channel.name}: ${describeError(error)}`);
    }

    const session = new VoiceSession(connection, channel, this.deps);
    this.sessions.set(channel.guild.id, session);
    session.onDestroyed(() => void this.handleSessionDestroyed(session));
    if (options.listen) await this.startListening(session);
    this.deps.logger.info(`Joined voice channel #${channel.name} in guild ${channel.guild.id} (listening: ${options.listen})`);
    this.checkOccupancy(session);
    return session;
  }

  /**
   * Keeps sessions in step with who is in their channels: starts the auto-leave countdown when the
   * bot is left alone (cancelling it when someone comes back), and follows the bot when someone
   * drags it to another channel.
   */
  voiceStateChanged(change: VoiceStateChange): void {
    const session = this.get(change.guildId);
    if (!session) return;
    if (change.userId === this.deps.botUserId()) {
      if (change.newChannel && change.newChannelId !== session.channelId) void this.followMove(session, change.newChannel);
      return;
    }
    if (change.oldChannelId === session.channelId || change.newChannelId === session.channelId) this.checkOccupancy(session);
  }

  /** Leaves the guild's voice channel. Returns false if the bot wasn't in one. */
  async leave(guildId: string): Promise<boolean> {
    const session = this.get(guildId);
    if (!session) return false;
    session.destroy();
    return true;
  }

  async leaveAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((guildId) => this.leave(guildId)));
  }

  // MusicHost ---------------------------------------------------------------

  async ensureOutput(guildId: string, voiceChannelId: string): Promise<MusicOutput> {
    const existing = this.get(guildId);
    if (existing) {
      if (existing.channelId !== voiceChannelId) {
        throw new MusicError(`I'm already in #${existing.channel.name}. Join that channel to control the music.`);
      }
      return existing.music;
    }
    const channel = await this.deps.resolveChannel(guildId, voiceChannelId);
    if (!channel) throw new MusicError("I couldn't find your voice channel.");
    const session = await this.join(channel, { listen: false });
    return session.music;
  }

  queueFinished(guildId: string): void {
    const session = this.get(guildId);
    // Stay if the assistant is listening; otherwise leave like a plain music bot.
    if (session && !session.listening) void this.leave(guildId);
  }

  // Internals ----------------------------------------------------------------

  private async startListening(session: VoiceSession): Promise<void> {
    const record = await this.deps.transcripts.startSession({
      guildId: session.guildId,
      channelId: session.channelId,
      channelName: session.channel.name,
      startedAt: this.deps.clock(),
    });
    session.transcriptSessionId = record.id;
    session.startListening((utterance) => {
      const handler = this.utteranceHandler;
      if (!handler) return;
      handler(session, utterance).catch((error: unknown) =>
        this.deps.logger.error(`Handling an utterance failed: ${describeError(error)}`),
      );
    });
  }

  private async stopListening(session: VoiceSession): Promise<void> {
    session.stopListening();
    const id = session.transcriptSessionId;
    session.transcriptSessionId = undefined;
    if (id === undefined) return;
    await this.deps.transcripts.endSession(id, this.deps.clock());
    const record = await this.deps.transcripts.getSession(id);
    if (!record) return;
    for (const listener of this.transcriptEndedListeners) {
      try {
        listener(record);
      } catch (error) {
        this.deps.logger.warn(`Transcript-ended listener failed: ${describeError(error)}`);
      }
    }
  }

  /** Someone moved the bot: the connection follows by itself; start a new transcript for the new channel. */
  private async followMove(session: VoiceSession, channel: VoiceBasedChannel): Promise<void> {
    const listening = session.listening;
    this.deps.logger.info(`Moved from #${session.channel.name} to #${channel.name} in guild ${session.guildId}`);
    try {
      if (listening) await this.stopListening(session);
      session.adoptChannel(channel);
      if (listening && !session.isDestroyed) await this.startListening(session);
    } catch (error) {
      this.deps.logger.warn(`Could not follow the move to #${channel.name}: ${describeError(error)}`);
    }
    this.checkOccupancy(session);
  }

  private checkOccupancy(session: VoiceSession): void {
    const { guildId } = session;
    if (this.deps.autoLeaveMs <= 0 || session.isDestroyed) return;
    if (session.humansPresent() > 0) {
      this.cancelAloneTimer(guildId);
      return;
    }
    if (this.aloneTimers.has(guildId)) return;
    const cancel = this.deps.schedule(() => {
      this.aloneTimers.delete(guildId);
      if (this.get(guildId) !== session || session.humansPresent() > 0) return;
      const minutes = Math.round(this.deps.autoLeaveMs / 60_000);
      this.deps.logger.info(`Leaving #${session.channel.name}: nobody has been there for ${minutes} minute${minutes === 1 ? '' : 's'}.`);
      void this.leave(guildId);
    }, this.deps.autoLeaveMs);
    this.aloneTimers.set(guildId, cancel);
  }

  private cancelAloneTimer(guildId: string): void {
    this.aloneTimers.get(guildId)?.();
    this.aloneTimers.delete(guildId);
  }

  private async handleSessionDestroyed(session: VoiceSession): Promise<void> {
    if (this.sessions.get(session.guildId) === session) {
      this.sessions.delete(session.guildId);
      this.cancelAloneTimer(session.guildId);
    }
    try {
      await this.stopListening(session);
    } catch (error) {
      this.deps.logger.warn(`Could not close transcript session: ${describeError(error)}`);
    }
    this.deps.logger.info(`Left voice channel #${session.channel.name} in guild ${session.guildId}`);
    for (const listener of this.endedListeners) listener(session.guildId);
  }
}
