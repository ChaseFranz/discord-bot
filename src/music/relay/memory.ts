import { randomUUID } from 'node:crypto';
import {
  MAX_CHUNK_BYTES,
  chunkName,
  type AudioRelayStore,
  type HelperRegistration,
  type HelperRegistry,
  type MusicJob,
  type MusicJobBoard,
  type MusicJobReport,
  type UploadTarget,
} from './ports.js';

/** Registrations kept in memory: for tests, and for trying the relay out on one machine. */
export class MemoryHelperRegistry implements HelperRegistry {
  private readonly byKey = new Map<string, HelperRegistration>();

  async register(registration: Omit<HelperRegistration, 'lastSeenAt' | 'version'>): Promise<void> {
    this.byKey.set(key(registration.guildId, registration.userId), { ...registration, lastSeenAt: null, version: null });
  }

  async find(guildId: string, userId: string): Promise<HelperRegistration | undefined> {
    const found = this.byKey.get(key(guildId, userId));
    return found ? { ...found } : undefined;
  }

  async checkIn(guildId: string, userId: string, at: number, version: string): Promise<void> {
    const found = this.byKey.get(key(guildId, userId));
    if (found) Object.assign(found, { lastSeenAt: at, version });
  }

  async list(guildId: string): Promise<HelperRegistration[]> {
    return [...this.byKey.values()].filter((registration) => registration.guildId === guildId).map((registration) => ({ ...registration }));
  }

  async remove(guildId: string, userId: string): Promise<boolean> {
    return this.byKey.delete(key(guildId, userId));
  }
}

export class MemoryMusicJobBoard implements MusicJobBoard {
  private readonly jobs = new Map<string, MusicJob>();

  async post(guildId: string, target: string, at: number): Promise<MusicJob> {
    const job: MusicJob = {
      id: randomUUID(), guildId, target, status: 'waiting', createdAt: at, updatedAt: at, helper: null, track: null, chunks: 0, error: null, listenedAt: null,
    };
    this.jobs.set(key(guildId, job.id), job);
    return { ...job };
  }

  async get(guildId: string, jobId: string): Promise<MusicJob | undefined> {
    const job = this.jobs.get(key(guildId, jobId));
    return job ? { ...job } : undefined;
  }

  async claim(guildId: string, helper: { userId: string; userName: string }, at: number, notBefore: number): Promise<MusicJob | undefined> {
    const waiting = [...this.jobs.values()]
      .filter((job) => job.guildId === guildId && job.status === 'waiting' && job.createdAt >= notBefore)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!waiting) return undefined;
    Object.assign(waiting, { status: 'claimed', helper: { ...helper }, updatedAt: at });
    return { ...waiting };
  }

  async report(guildId: string, jobId: string, helperUserId: string, report: MusicJobReport, at: number): Promise<boolean> {
    const job = this.jobs.get(key(guildId, jobId));
    if (!job || job.helper?.userId !== helperUserId || (job.status !== 'claimed' && job.status !== 'found')) return false;
    job.updatedAt = at;
    if (report.kind === 'found') Object.assign(job, { status: 'found', track: { ...report.track } });
    else if (report.kind === 'failed') Object.assign(job, { status: 'failed', error: report.error });
    else {
      job.chunks = Math.max(job.chunks, report.chunks);
      if (report.kind === 'done') job.status = 'done';
    }
    return true;
  }

  async abandon(guildId: string, jobId: string, reason: string, at: number): Promise<void> {
    const job = this.jobs.get(key(guildId, jobId));
    if (!job || job.status === 'done' || job.status === 'failed') return;
    Object.assign(job, { status: 'failed', error: reason, updatedAt: at });
  }

  async listening(guildId: string, jobId: string, at: number): Promise<void> {
    const job = this.jobs.get(key(guildId, jobId));
    if (job && (job.status === 'claimed' || job.status === 'found')) job.listenedAt = at;
  }
}

/** Audio kept in memory. `uploadTarget` points at `uploadUrl`, where something must accept the chunks (see put). */
export class MemoryAudioRelayStore implements AudioRelayStore {
  private readonly chunks = new Map<string, Uint8Array>();

  /** How many forms have been handed out. */
  issued = 0;

  constructor(
    private readonly uploadUrl = 'http://localhost/upload',
    private readonly expiresInSeconds = 30 * 60,
  ) {}

  async uploadTarget(guildId: string, jobId: string): Promise<UploadTarget> {
    this.issued++;
    return {
      url: this.uploadUrl,
      fields: { policy: 'memory' },
      keyPrefix: `music/${guildId}/${jobId}/`,
      maxChunkBytes: MAX_CHUNK_BYTES,
      expiresInSeconds: this.expiresInSeconds,
    };
  }

  async read(guildId: string, jobId: string, index: number): Promise<Uint8Array | undefined> {
    return this.chunks.get(`music/${guildId}/${jobId}/${chunkName(index)}`);
  }

  /** Stores an uploaded chunk under the key the helper sent. */
  put(objectKey: string, bytes: Uint8Array): void {
    this.chunks.set(objectKey, bytes);
  }
}

function key(guildId: string, id: string): string {
  return `${guildId}/${id}`;
}
