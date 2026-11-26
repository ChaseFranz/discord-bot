import type { Readable } from 'node:stream';

export interface Track {
  title: string;
  url: string;
  durationSeconds?: number;
  /** Display name of whoever queued it. */
  requestedBy?: string;
}

/** Where tracks come from (YouTube today). */
export interface TrackSource {
  /** Resolves a URL or free-text search into a playable track, or null when nothing matches. */
  resolve(query: string): Promise<Track | null>;
  /** Opens an audio stream for the track, in any container/codec ffmpeg can read. */
  open(track: Track): Promise<Readable>;
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

/** An expected, user-facing failure such as "nothing is playing". */
export class MusicError extends Error {
  override readonly name = 'MusicError';
}
