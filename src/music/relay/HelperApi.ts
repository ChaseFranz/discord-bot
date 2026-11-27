import type { Logger } from '../../logging/logger.js';
import type { Clock } from '../../util/time.js';
import { CHECK_IN_EVERY_MS, HELPER_POLL_MS, UNHEARD_MS } from './HelperDesk.js';
import type { AudioRelayStore, HelperRegistry, MusicJob, MusicJobBoard, MusicJobReport } from './ports.js';
import { parseToken, secretMatches } from './tokens.js';

export interface HelperApiDeps {
  /** The one server this deployment serves; tokens for any other are refused. */
  guildId: string;
  registry: HelperRegistry;
  board: MusicJobBoard;
  store: AudioRelayStore;
  clock: Clock;
  logger: Logger;
  /** How long helpers are told to wait between polls (default HELPER_POLL_MS). */
  pollMs?: number;
}

export interface HelperApiRequest {
  method: string;
  path: string;
  body: string | undefined;
}

export interface HelperApiResponse {
  status: number;
  body: Record<string, unknown>;
}

const MAX_BODY_CHARACTERS = 10_000;
/** A job older than this is not handed out: whoever asked has stopped waiting for it. */
export const JOB_FRESH_MS = 30_000;
const VIDEO_ID = /^[\w-]{11}$/;
/** As many as chunk names have digits for (see chunkName). */
const MAX_CHUNKS = 999_999;
/** Why a live stream was stopped when the bot had stopped listening to it. */
export const NOBODY_LISTENING = 'nobody was listening any more';

/**
 * What music helpers talk to, over plain HTTPS requests they make themselves (so they work from
 * behind any home router). Every request carries the helper's token.
 *
 *   POST /poll    { token, version }               -> { job: null | { id, target, upload }, pollMs }
 *   POST /report  { token, jobId, kind, ... }      -> { ok }
 *   POST /upload  { token, jobId }                 -> { upload: null | { ... } }
 *
 * Polling is also how the bot knows a helper is running: each poll counts as a check-in.
 *
 * `ok: false` and `upload: null` both mean the job is over as far as the bot is concerned (it gave
 * up on it, the song was skipped, or it is a live stream nobody is listening to any more), and the
 * helper stops sending.
 */
export class HelperApi {
  constructor(private readonly deps: HelperApiDeps) {}

  async handle(request: HelperApiRequest): Promise<HelperApiResponse> {
    const path = request.path.replace(/\/+$/, '') || '/';
    if (request.method === 'GET' && path === '/') return { status: 200, body: { service: 'nimbus-music-helper', ok: true } };
    if (request.method !== 'POST') return failure(405, 'Use POST.');
    if (path !== '/poll' && path !== '/report' && path !== '/upload') return failure(404, 'No such address.');
    const body = parseBody(request.body);
    if (!body) return failure(400, 'Send a JSON object.');

    const token = parseToken(body.token);
    const registration = token && token.guildId === this.deps.guildId ? await this.deps.registry.find(token.guildId, token.userId) : undefined;
    if (!token || !registration || !secretMatches(token.secret, registration.secretHash)) {
      return failure(401, 'This helper code no longer works. Get a new one with /musichelper.');
    }
    const helper = { userId: registration.userId, userName: registration.userName };
    if (path === '/poll') return this.poll(helper, registration.lastSeenAt, body);
    return path === '/report' ? this.report(helper, body) : this.upload(helper, body);
  }

  private async poll(helper: { userId: string; userName: string }, lastSeenAt: number | null, body: Record<string, unknown>): Promise<HelperApiResponse> {
    const { guildId, registry, board, store, clock } = this.deps;
    const now = clock();
    if (lastSeenAt === null || now - lastSeenAt >= CHECK_IN_EVERY_MS) {
      const version = typeof body.version === 'string' ? body.version.slice(0, 40) : 'unknown';
      await registry.checkIn(guildId, helper.userId, now, version);
    }
    const job = await board.claim(guildId, helper, now, now - JOB_FRESH_MS);
    const pollMs = this.deps.pollMs ?? HELPER_POLL_MS;
    if (!job) return { status: 200, body: { job: null, pollMs } };
    this.deps.logger.info(`Music helper of ${helper.userName} took job ${job.id}.`);
    return { status: 200, body: { job: { id: job.id, target: job.target, upload: await store.uploadTarget(guildId, job.id) }, pollMs } };
  }

  private async report(helper: { userId: string; userName: string }, body: Record<string, unknown>): Promise<HelperApiResponse> {
    const { guildId, board, clock, logger } = this.deps;
    const report = parseReport(body);
    if (typeof body.jobId !== 'string' || body.jobId.length > 100 || !report) return failure(400, 'That report is not one this service understands.');
    const now = clock();
    if (report.kind === 'progress') {
      const job = await board.get(guildId, body.jobId);
      if (job && (await this.unheard(job, helper, now))) return { status: 200, body: { ok: false } };
    }
    const ok = await board.report(guildId, body.jobId, helper.userId, report, now);
    // A live stream is sent for as long as someone listens. The bot gets until UNHEARD_MS from now to start.
    if (ok && report.kind === 'found' && report.track.live) await board.listening(guildId, body.jobId, now);
    if (report.kind === 'failed') logger.info(`Music helper of ${helper.userName} could not finish job ${body.jobId}: ${report.error}`);
    // Not ok: the job is over. The helper stops sending.
    return { status: 200, body: { ok } };
  }

  /** A new upload form for a job that is taking longer than its first one lasts (a long video, a live stream). */
  private async upload(helper: { userId: string; userName: string }, body: Record<string, unknown>): Promise<HelperApiResponse> {
    const { guildId, board, store, clock } = this.deps;
    if (typeof body.jobId !== 'string' || body.jobId.length > 100) return failure(400, 'Say which job the upload is for.');
    const job = await board.get(guildId, body.jobId);
    const theirs = job !== undefined && job.helper?.userId === helper.userId && (job.status === 'claimed' || job.status === 'found');
    if (!theirs || (await this.unheard(job, helper, clock()))) return { status: 200, body: { upload: null } };
    return { status: 200, body: { upload: await store.uploadTarget(guildId, job.id) } };
  }

  /**
   * Whether `job` is a live stream of this helper's that the bot has stopped listening to (the song
   * was never played, or the call ended without saying so). If so it is given up on here.
   */
  private async unheard(job: MusicJob, helper: { userId: string; userName: string }, now: number): Promise<boolean> {
    const going = job.helper?.userId === helper.userId && (job.status === 'claimed' || job.status === 'found');
    if (!going || job.track?.live !== true || now - (job.listenedAt ?? job.updatedAt) <= UNHEARD_MS) return false;
    await this.deps.board.abandon(this.deps.guildId, job.id, NOBODY_LISTENING, now);
    this.deps.logger.info(`Stopped the live stream ${helper.userName}'s music helper was sending (job ${job.id}): nobody was listening any more.`);
    return true;
  }
}

function failure(status: number, error: string): HelperApiResponse {
  return { status, body: { error } };
}

function parseBody(body: string | undefined): Record<string, unknown> | undefined {
  if (!body || body.length > MAX_BODY_CHARACTERS) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function parseReport(body: Record<string, unknown>): MusicJobReport | undefined {
  const chunks = typeof body.chunks === 'number' && Number.isInteger(body.chunks) && body.chunks >= 0 && body.chunks <= MAX_CHUNKS ? body.chunks : undefined;
  switch (body.kind) {
    case 'found': {
      const { videoId, title, durationSeconds } = body;
      if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId) || typeof title !== 'string') return undefined;
      const duration = typeof durationSeconds === 'number' && durationSeconds > 0 && durationSeconds < 1_000_000 ? Math.round(durationSeconds) : undefined;
      return {
        kind: 'found',
        track: {
          videoId,
          title: title.replace(/\s+/g, ' ').trim().slice(0, 300) || videoId,
          ...(duration ? { durationSeconds: duration } : {}),
          ...(body.live === true ? { live: true } : {}),
        },
      };
    }
    case 'progress':
      return chunks === undefined ? undefined : { kind: 'progress', chunks };
    case 'done':
      return chunks === undefined ? undefined : { kind: 'done', chunks };
    case 'failed':
      return typeof body.error === 'string' ? { kind: 'failed', error: body.error.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error' } : undefined;
    default:
      return undefined;
  }
}
