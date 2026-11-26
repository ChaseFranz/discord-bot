import { VoiceConnectionStatus, entersState, joinVoiceChannel } from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import type { Logger } from '../logging/logger.js';
import { describeError } from '../logging/logger.js';
import { MusicError, type MusicHost, type MusicOutput } from '../music/types.js';
import type { TranscriptRepository } from '../storage/ports.js';
import type { CapturedUtterance } from './SpeechCapture.js';
import { VoiceSession, type VoiceSessionDeps } from './VoiceSession.js';

export type UtteranceHandler = (session: VoiceSession, utterance: CapturedUtterance) => Promise<void>;
export type ChannelResolver = (guildId: string, channelId: string) => Promise<VoiceBasedChannel | null>;

export interface VoiceSessionManagerDeps extends VoiceSessionDeps {
  transcripts: TranscriptRepository;
  resolveChannel: ChannelResolver;
}

const READY_TIMEOUT_MS = 30_000;

/** Owns at most one VoiceSession per guild and decides when to join, move and leave. */
export class VoiceSessionManager implements MusicHost {
  private readonly sessions = new Map<string, VoiceSession>();
  private utteranceHandler: UtteranceHandler | undefined;
  private readonly endedListeners: Array<(guildId: string) => void> = [];

  constructor(private readonly deps: VoiceSessionManagerDeps) {}

  /** Receives every transcribed utterance while a session is listening. */
  setUtteranceHandler(handler: UtteranceHandler): void {
    this.utteranceHandler = handler;
  }

  /** Called with the guild id whenever a session ends (left, kicked, or disconnected). */
  onSessionEnded(listener: (guildId: string) => void): void {
    this.endedListeners.push(listener);
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
    return session;
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
    if (id !== undefined) await this.deps.transcripts.endSession(id, this.deps.clock());
  }

  private async handleSessionDestroyed(session: VoiceSession): Promise<void> {
    if (this.sessions.get(session.guildId) === session) this.sessions.delete(session.guildId);
    try {
      await this.stopListening(session);
    } catch (error) {
      this.deps.logger.warn(`Could not close transcript session: ${describeError(error)}`);
    }
    this.deps.logger.info(`Left voice channel #${session.channel.name} in guild ${session.guildId}`);
    for (const listener of this.endedListeners) listener(session.guildId);
  }
}
