import type { Readable } from 'node:stream';

export interface Track {
  title: string;
  url: string;
  durationSeconds?: number;
  /** Display name of whoever queued it. */
  requestedBy?: string;
  /** Something the source that resolved it can use to open it (meaningless to anything else). */
  handle?: string;
}

/** Where tracks come from (YouTube today). */
export interface TrackSource {
  /** Resolves a URL or free-text search into a playable track, or null when nothing matches. */
  resolve(query: string): Promise<Track | null>;
  /** Opens an audio stream for the track, in any container/codec ffmpeg can read. */
  open(track: Track): Promise<Readable>;
  /**
   * Told that a track from `resolve` has left the queue (it finished, was skipped, or the queue was
   * cleared), so anything still being prepared for it can stop. Optional: most sources have nothing
   * going on between `resolve` and `open`.
   */
  discard?(track: Track): Promise<void>;
}

export type PlaybackState = 'idle' | 'buffering' | 'playing' | 'paused';

/** The audio output music plays through in one guild's voice channel. */
export interface MusicOutput {
  readonly state: PlaybackState;
  play(stream: Readable): void;
  stop(): void;
  /** Returns false if there was nothing to pause. */
  pause(): boolean;
  /** Returns false if it wasn't paused. */
  resume(): boolean;
  /** Fires when the current track finishes (or is stopped). Returns an unsubscribe function. */
  onIdle(listener: () => void): () => void;
  onError(listener: (error: Error) => void): () => void;
}

/** Supplies music outputs; implemented by the voice session manager. */
export interface MusicHost {
  /** Ensures the bot is connected to `voiceChannelId` and returns that guild's music output. */
  ensureOutput(guildId: string, voiceChannelId: string): Promise<MusicOutput>;
  /** Called when a guild's queue runs out, so the host can leave if nothing else needs the channel. */
  queueFinished(guildId: string): void;
}

export interface MusicStatus {
  state: PlaybackState;
  current: Track | undefined;
  upcoming: Track[];
}

/** What people are told while MUSIC_ENABLED is off. */
export const MUSIC_TURNED_OFF = 'Music is turned off for now.';

/** An expected, user-facing failure such as "nothing is playing". */
export class MusicError extends Error {
  override readonly name = 'MusicError';
}
