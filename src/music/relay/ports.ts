/**
 * Music helpers: YouTube won't send audio to data-center addresses, so where the bot runs on one
 * (AWS), a small program on someone's own computer fetches the audio and relays it. These are the
 * ports that coordination goes through; see HelperApi (what a helper talks to) and
 * HelperTrackSource (the bot's side).
 */

/** Someone's registration to run a music helper for a server. */
export interface HelperRegistration {
  guildId: string;
  userId: string;
  userName: string;
  /** SHA-256 (hex) of the secret half of their token. The secret itself is never stored. */
  secretHash: string;
  createdAt: number;
  /** When their helper last checked in; null if it never has. */
  lastSeenAt: number | null;
  /** The helper's version, as it last reported it. */
  version: string | null;
}

export interface HelperRegistry {
  /** Registers the person, replacing any earlier registration (and so any earlier token). */
  register(registration: Omit<HelperRegistration, 'lastSeenAt' | 'version'>): Promise<void>;
  find(guildId: string, userId: string): Promise<HelperRegistration | undefined>;
  /** Records that their helper checked in. */
  checkIn(guildId: string, userId: string, at: number, version: string): Promise<void>;
  /** Everyone registered in the server. */
  list(guildId: string): Promise<HelperRegistration[]>;
  /** Removes the registration; their token stops working. Returns false if there was none. */
  remove(guildId: string, userId: string): Promise<boolean>;
}

/**
 * A request for a song, from being asked for to being fully relayed:
 * waiting (no helper has it yet) -> claimed -> found (the helper knows which video it is) -> done,
 * or failed at any point.
 */
export type MusicJobStatus = 'waiting' | 'claimed' | 'found' | 'done' | 'failed';

export interface RelayedTrack {
  videoId: string;
  title: string;
  durationSeconds?: number;
  /**
   * A live stream: it has no end, and its audio arrives only as fast as it is broadcast. It is
   * sent for as long as someone is listening (see MusicJob.listenedAt), not fetched ahead.
   */
  live?: boolean;
}

export interface MusicJob {
  id: string;
  guildId: string;
  /** What to fetch: a YouTube watch URL, or `ytsearch1:` followed by words to search for. */
  target: string;
  status: MusicJobStatus;
  createdAt: number;
  updatedAt: number;
  helper: { userId: string; userName: string } | null;
  track: RelayedTrack | null;
  /** How many chunks of audio have been uploaded: chunks 0 to chunks-1 can be read. */
  chunks: number;
  /** Why it failed, in words for the person who asked. */
  error: string | null;
  /**
   * When the bot last said it is listening to this. It only matters for a live stream, which would
   * otherwise be sent for ever: one that nobody has listened to for a while is stopped.
   */
  listenedAt: number | null;
}

/** What a helper reports about a job it holds. */
export type MusicJobReport =
  | { kind: 'found'; track: RelayedTrack }
  | { kind: 'progress'; chunks: number }
  | { kind: 'done'; chunks: number }
  | { kind: 'failed'; error: string };

export interface MusicJobBoard {
  post(guildId: string, target: string, at: number): Promise<MusicJob>;
  get(guildId: string, jobId: string): Promise<MusicJob | undefined>;
  /** Gives this helper the oldest job still waiting that was posted at or after `notBefore`. */
  claim(guildId: string, helper: { userId: string; userName: string }, at: number, notBefore: number): Promise<MusicJob | undefined>;
  /** Records a report from the helper holding the job. Returns false if it isn't theirs, or is already over. */
  report(guildId: string, jobId: string, helperUserId: string, report: MusicJobReport, at: number): Promise<boolean>;
  /** Marks a job nobody finished as failed, so no helper picks it up or carries on with it. */
  abandon(guildId: string, jobId: string, reason: string, at: number): Promise<void>;
  /** Notes that the bot is listening to a job that is still going (see MusicJob.listenedAt). */
  listening(guildId: string, jobId: string, at: number): Promise<void>;
}

/** What a helper needs to upload a job's audio, one chunk per request. */
export interface UploadTarget {
  /** Where to POST each chunk as a multipart form. */
  url: string;
  /** Form fields to send with every chunk, before the file itself. */
  fields: Record<string, string>;
  /** Each chunk's `key` field is this followed by its number (see chunkKey). */
  keyPrefix: string;
  maxChunkBytes: number;
  /** How long the form can be used for. A helper still sending by then asks for a new one. */
  expiresInSeconds: number;
}

/** Where a helper puts a job's audio, and where the bot reads it back. */
export interface AudioRelayStore {
  uploadTarget(guildId: string, jobId: string): Promise<UploadTarget>;
  /** One chunk's bytes, or undefined if it isn't there. */
  read(guildId: string, jobId: string, index: number): Promise<Uint8Array | undefined>;
}

/** The name of a chunk within its job: zero-padded so they sort in order. */
export function chunkName(index: number): string {
  return String(index).padStart(6, '0');
}

/** Larger than any chunk a helper sends (it sends about a quarter of a megabyte at a time). */
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
