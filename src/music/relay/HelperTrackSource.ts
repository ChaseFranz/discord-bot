import { Readable } from 'node:stream';
import type { Clock } from '../../util/time.js';
import { MusicError, type Track, type TrackSource } from '../types.js';
import { youTubeVideoId } from '../YtDlpTrackSource.js';
import { LISTENING_EVERY_MS, type HelperDesk } from './HelperDesk.js';
import type { AudioRelayStore, MusicJob, MusicJobBoard } from './ports.js';

export interface HelperTrackSourceDeps {
  guildId: string;
  desk: Pick<HelperDesk, 'blocker' | 'guideUrl'>;
  board: MusicJobBoard;
  store: AudioRelayStore;
  clock: Clock;
  /** How often the job is looked at while waiting on a helper. */
  checkEveryMs?: number;
  /** Waits `ms`; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Runs `run` every `ms` until the returned function is called; replaced in tests. */
  every?: (ms: number, run: () => void) => () => void;
}

/** What a helper reports when the search came back empty. */
export const NOTHING_FOUND = 'nothing-found';
/** What a helper reports for a live stream when it has no ffmpeg, which fetching one needs. */
export const LIVE_NEEDS_FFMPEG = 'live-needs-ffmpeg';
/** Why a job was given up on when its track left the queue before the helper had finished. */
const NO_LONGER_WANTED = 'no longer wanted';
/** A helper asks for work every few seconds, so one that is running has taken the job by now. */
const CLAIM_PATIENCE_MS = 12_000;
/** How long a helper may go without reporting anything new before the bot gives up on it. */
const PROGRESS_PATIENCE_MS = 30_000;

/**
 * YouTube audio fetched by a music helper on someone's own computer, for when the bot itself runs
 * somewhere YouTube won't serve (see ports.ts). Asking for a track posts a job; a running helper
 * takes it, says which video it found, and uploads the audio in chunks, which are played as they
 * arrive.
 */
export class HelperTrackSource implements TrackSource {
  private readonly checkEveryMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly every: (ms: number, run: () => void) => () => void;

  constructor(private readonly deps: HelperTrackSourceDeps) {
    this.checkEveryMs = deps.checkEveryMs ?? 250;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.every =
      deps.every ??
      ((ms, run) => {
        const timer = setInterval(run, ms);
        return () => clearInterval(timer);
      });
  }

  async resolve(query: string): Promise<Track | null> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return null;
    const blocker = await this.deps.desk.blocker();
    if (blocker) throw new MusicError(blocker);

    const id = youTubeVideoId(trimmed);
    const job = await this.deps.board.post(this.deps.guildId, id ? watchUrl(id) : `ytsearch1:${trimmed}`, this.deps.clock());
    const found = await this.untilFound(job);
    if (!found) return null;
    return {
      title: found.track!.title,
      url: watchUrl(found.track!.videoId),
      ...(found.track!.durationSeconds ? { durationSeconds: found.track!.durationSeconds } : {}),
      handle: found.id,
    };
  }

  async open(track: Track): Promise<Readable> {
    let jobId = track.handle;
    if (jobId) {
      // Given up on while it waited its turn (a live stream is only sent while someone listens; a
      // helper may have gone away half-way through a song)? Then it is asked for again.
      const job = await this.deps.board.get(this.deps.guildId, jobId);
      if (!job || job.status === 'failed') jobId = undefined;
    }
    if (!jobId) {
      const again = await this.resolve(track.url);
      if (!again?.handle) throw new Error(`Nothing was found for ${track.url}`);
      // So that letting go of the track later stops this fetch, not the one before it.
      track.handle = again.handle;
      jobId = again.handle;
    }
    return this.stream(jobId);
  }

  /** A job's audio as a stream that stops looking for more the moment it is closed. */
  private stream(jobId: string): Readable {
    const closed = new AbortController();
    const stream = Readable.from(this.chunks(jobId, closed.signal));
    // Closing a stream made from a generator waits for the generator's current step. Ours may be
    // waiting for the next part of a song: tell it first, so it stops there.
    const destroy = stream._destroy.bind(stream);
    stream._destroy = (error, callback) => {
      closed.abort();
      destroy(error, callback);
    };
    return stream;
  }

  /**
   * The track has left the queue. If its helper is still sending it (a long video, say, that was
   * skipped a minute in), the helper is told to stop at its next report. A song that has already
   * arrived is left as it is.
   */
  async discard(track: Track): Promise<void> {
    if (track.handle) await this.deps.board.abandon(this.deps.guildId, track.handle, NO_LONGER_WANTED, this.deps.clock());
  }

  /** Waits until a helper has said which video the job is (or that there is none). */
  private async untilFound(posted: MusicJob): Promise<MusicJob | undefined> {
    const { board, clock, guildId } = this.deps;
    const giveUp = async (reason: string): Promise<never> => {
      await board.abandon(guildId, posted.id, reason, clock());
      throw new MusicError(reason);
    };
    for (let job: MusicJob | undefined = posted; ; job = await board.get(guildId, posted.id)) {
      if (!job) throw new MusicError('That request got lost. Please try again.');
      if (job.status === 'found' || job.status === 'done') return job;
      if (job.status === 'failed') {
        if (job.error === NOTHING_FOUND) return undefined;
        throw new MusicError(this.liveProblem(job) ?? `The music helper couldn't get that: ${job.error ?? 'something went wrong'}`);
      }
      const waited = clock() - job.updatedAt;
      if (job.status === 'waiting' && waited > CLAIM_PATIENCE_MS) {
        await giveUp("No music helper picked that up. If yours is running, check that it's still connected.");
      }
      if (job.status === 'claimed' && waited > PROGRESS_PATIENCE_MS) {
        await giveUp(`${job.helper?.userName ?? 'The'}'s music helper took too long to find that.`);
      }
      await this.sleep(this.checkEveryMs);
    }
  }

  /** If a job failed because it is a live stream its helper couldn't fetch: why, for whoever asked for it. */
  private liveProblem(job: MusicJob): string | undefined {
    const whose = job.helper ? `${job.helper.userName}'s music helper` : 'the music helper';
    if (job.error === LIVE_NEEDS_FFMPEG) {
      return `That's a live stream, and ${whose} has no ffmpeg, which fetching one takes. How to add it: ${this.deps.desk.guideUrl}`;
    }
    // An older helper, which doesn't fetch ffmpeg for itself, passes on what yt-dlp said.
    if (/ffmpeg could not be found/i.test(job.error ?? '')) {
      return `That's a live stream, and ${whose} is too old to play those. The newer one is here: ${this.deps.desk.guideUrl}`;
    }
    return undefined;
  }

  /** The job's audio in order, each chunk as soon as it has been uploaded, until `closed` (nobody is reading any more). */
  private async *chunks(jobId: string, closed: AbortSignal): AsyncGenerator<Buffer> {
    const { board, store, clock, guildId } = this.deps;
    let next = 0;
    let lastProgress = clock();
    let stopListening: (() => void) | undefined;
    try {
      for (;;) {
        const job = await board.get(guildId, jobId);
        if (closed.aborted) return;
        if (!job) throw new Error('The song is no longer available.');
        if (job.track?.live && !stopListening && (job.status === 'claimed' || job.status === 'found')) {
          // A live stream is sent for as long as someone is listening: say so now, and keep saying
          // so until this stream is closed (also while the music is paused).
          const listening = () => void board.listening(guildId, jobId, clock()).catch(() => undefined);
          listening();
          stopListening = this.every(LISTENING_EVERY_MS, listening);
        }
        while (next < job.chunks) {
          const bytes = await store.read(guildId, jobId, next);
          if (closed.aborted) return;
          if (!bytes) throw new Error(`Part ${next} of the song is missing.`);
          yield Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          next++;
          lastProgress = clock();
        }
        if (job.status === 'done') return;
        if (job.status === 'failed') throw new Error(this.liveProblem(job) ?? `The music helper stopped part-way: ${job.error ?? 'unknown error'}`);
        if (clock() - lastProgress > PROGRESS_PATIENCE_MS) {
          await board.abandon(guildId, jobId, 'The music helper stopped sending the song.', clock());
          throw new Error('The music helper stopped sending the song.');
        }
        await this.sleep(this.checkEveryMs);
        if (closed.aborted) return;
      }
    } finally {
      stopListening?.();
    }
  }
}

function watchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}
