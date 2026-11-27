import { Readable } from 'node:stream';
import type { Clock } from '../../util/time.js';
import { MusicError, type Track, type TrackSource } from '../types.js';
import { youTubeVideoId } from '../YtDlpTrackSource.js';
import type { HelperDesk } from './HelperDesk.js';
import type { AudioRelayStore, MusicJob, MusicJobBoard } from './ports.js';

export interface HelperTrackSourceDeps {
  guildId: string;
  desk: Pick<HelperDesk, 'blocker'>;
  board: MusicJobBoard;
  store: AudioRelayStore;
  clock: Clock;
  /** How often the job is looked at while waiting on a helper. */
  checkEveryMs?: number;
  /** Waits `ms`; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** What a helper reports when the search came back empty. */
export const NOTHING_FOUND = 'nothing-found';
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

  constructor(private readonly deps: HelperTrackSourceDeps) {
    this.checkEveryMs = deps.checkEveryMs ?? 250;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
    if (track.handle) return Readable.from(this.chunks(track.handle));
    // No audio on its way for this one: ask a helper for it again.
    const again = await this.resolve(track.url);
    if (!again?.handle) throw new Error(`Nothing was found for ${track.url}`);
    return Readable.from(this.chunks(again.handle));
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
        throw new MusicError(`The music helper couldn't get that: ${job.error ?? 'something went wrong'}`);
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

  /** The job's audio in order, each chunk as soon as it has been uploaded. */
  private async *chunks(jobId: string): AsyncGenerator<Buffer> {
    const { board, store, clock, guildId } = this.deps;
    let next = 0;
    let lastProgress = clock();
    for (;;) {
      const job = await board.get(guildId, jobId);
      if (!job) throw new Error('The song is no longer available.');
      while (next < job.chunks) {
        const bytes = await store.read(guildId, jobId, next);
        if (!bytes) throw new Error(`Part ${next} of the song is missing.`);
        yield Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        next++;
        lastProgress = clock();
      }
      if (job.status === 'done') return;
      if (job.status === 'failed') throw new Error(`The music helper stopped part-way: ${job.error ?? 'unknown error'}`);
      if (clock() - lastProgress > PROGRESS_PATIENCE_MS) {
        await board.abandon(guildId, jobId, 'The music helper stopped sending the song.', clock());
        throw new Error('The music helper stopped sending the song.');
      }
      await this.sleep(this.checkEveryMs);
    }
  }
}

function watchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}
