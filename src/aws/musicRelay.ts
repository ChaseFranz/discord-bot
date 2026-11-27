import { randomBytes } from 'node:crypto';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import {
  MAX_CHUNK_BYTES,
  chunkName,
  type AudioRelayStore,
  type HelperRegistration,
  type HelperRegistry,
  type MusicJob,
  type MusicJobBoard,
  type MusicJobReport,
  type RelayedTrack,
  type UploadTarget,
} from '../music/relay/ports.js';
import { isConflict, names, pad, queryAll, type Item } from '../storage/dynamodb/dynamo.js';

/** Jobs and their audio are kept for a day: long enough for a song waiting in a queue to be played. */
const JOB_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** How long a helper has to upload a song with the form it was given. */
const UPLOAD_WINDOW_SECONDS = 30 * 60;

/** Music helper registrations in the main table: `HELPER#<guild>` / `USER#<user>`. */
export class DynamoHelperRegistry implements HelperRegistry {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async register(registration: Omit<HelperRegistration, 'lastSeenAt' | 'version'>): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...helperKey(registration.guildId, registration.userId), ...registration } }));
  }

  async find(guildId: string, userId: string): Promise<HelperRegistration | undefined> {
    const result = await this.doc.send(new GetCommand({ TableName: this.table, Key: helperKey(guildId, userId), ConsistentRead: true }));
    return result.Item ? toRegistration(result.Item) : undefined;
  }

  async checkIn(guildId: string, userId: string, at: number, version: string): Promise<void> {
    const attr = names('lastSeenAt', 'version');
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: helperKey(guildId, userId),
          UpdateExpression: `SET ${attr.refs[0]} = :at, ${attr.refs[1]} = :version`,
          // A registration that has been removed must not come back with a check-in.
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: attr.map,
          ExpressionAttributeValues: { ':at': at, ':version': version },
        }),
      );
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }

  async list(guildId: string): Promise<HelperRegistration[]> {
    const items = await queryAll(this.doc, {
      TableName: this.table,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `HELPER#${guildId}` },
    });
    return items.map(toRegistration);
  }

  async remove(guildId: string, userId: string): Promise<boolean> {
    const result = await this.doc.send(new DeleteCommand({ TableName: this.table, Key: helperKey(guildId, userId), ReturnValues: 'ALL_OLD' }));
    return result.Attributes !== undefined;
  }
}

/**
 * Requests for songs in the main table: `MUSICJOB#<guild>` / `JOB#<id>`. An id starts with the
 * time it was posted, so a guild's jobs sort by age. Each expires a day later.
 */
export class DynamoMusicJobBoard implements MusicJobBoard {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async post(guildId: string, target: string, at: number): Promise<MusicJob> {
    const job: MusicJob = {
      id: `${pad(at)}-${randomBytes(6).toString('hex')}`,
      guildId, target, status: 'waiting', createdAt: at, updatedAt: at, helper: null, track: null, chunks: 0, error: null,
    };
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { ...jobKey(guildId, job.id), ...job, expiresAt: Math.floor((at + JOB_LIFETIME_MS) / 1000) },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return job;
  }

  async get(guildId: string, jobId: string): Promise<MusicJob | undefined> {
    const result = await this.doc.send(new GetCommand({ TableName: this.table, Key: jobKey(guildId, jobId), ConsistentRead: true }));
    return result.Item ? toJob(result.Item) : undefined;
  }

  async claim(guildId: string, helper: { userId: string; userName: string }, at: number, notBefore: number): Promise<MusicJob | undefined> {
    const attr = names('status');
    const recent = await queryAll(this.doc, {
      TableName: this.table,
      KeyConditionExpression: 'pk = :pk AND sk >= :since',
      FilterExpression: `${attr.refs[0]} = :waiting`,
      ExpressionAttributeNames: attr.map,
      ExpressionAttributeValues: { ':pk': `MUSICJOB#${guildId}`, ':since': `JOB#${pad(Math.max(0, notBefore))}`, ':waiting': 'waiting' },
      ConsistentRead: true,
    });
    // Oldest first. Another helper may take one in the meantime; then the next is tried.
    for (const item of recent) {
      const job = toJob(item);
      if (await this.update(guildId, job.id, { status: 'claimed', helper, updatedAt: at }, `${attr.refs[0]} = :waiting`, attr.map, { ':waiting': 'waiting' })) {
        return { ...job, status: 'claimed', helper, updatedAt: at };
      }
    }
    return undefined;
  }

  async report(guildId: string, jobId: string, helperUserId: string, report: MusicJobReport, at: number): Promise<boolean> {
    const attr = names('status', 'helper');
    // Only the helper that holds the job, and only while it is still going.
    const theirs = `${attr.refs[1]}.userId = :helper AND ${attr.refs[0]} IN (:claimed, :found)`;
    const values = { ':helper': helperUserId, ':claimed': 'claimed', ':found': 'found' };
    if (report.kind === 'found') return this.update(guildId, jobId, { status: 'found', track: report.track, updatedAt: at }, theirs, attr.map, values);
    if (report.kind === 'failed') return this.update(guildId, jobId, { status: 'failed', error: report.error, updatedAt: at }, theirs, attr.map, values);
    if (report.kind === 'done') return this.update(guildId, jobId, { status: 'done', chunks: report.chunks, updatedAt: at }, theirs, attr.map, values);
    // Progress never goes backwards: a report that arrives late changes nothing, but is still fine.
    const chunks = names('chunks');
    const advanced = await this.update(
      guildId,
      jobId,
      { chunks: report.chunks, updatedAt: at },
      `${theirs} AND ${chunks.refs[0]} < :chunks`,
      { ...attr.map, ...chunks.map },
      { ...values, ':chunks': report.chunks },
    );
    if (advanced) return true;
    const job = await this.get(guildId, jobId);
    return job !== undefined && job.helper?.userId === helperUserId && (job.status === 'claimed' || job.status === 'found');
  }

  async abandon(guildId: string, jobId: string, reason: string, at: number): Promise<void> {
    const attr = names('status');
    await this.update(guildId, jobId, { status: 'failed', error: reason, updatedAt: at }, `${attr.refs[0]} IN (:waiting, :claimed, :found)`, attr.map, {
      ':waiting': 'waiting',
      ':claimed': 'claimed',
      ':found': 'found',
    });
  }

  /** Sets attributes on a job if `condition` holds. Returns whether it did. */
  private async update(
    guildId: string,
    jobId: string,
    set: Record<string, unknown>,
    condition: string,
    conditionNames: Record<string, string>,
    conditionValues: Record<string, unknown>,
  ): Promise<boolean> {
    const attr = names(...Object.keys(set));
    const values = Object.fromEntries(Object.values(set).map((value, index) => [`:set${index}`, value]));
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: jobKey(guildId, jobId),
          UpdateExpression: `SET ${attr.refs.map((ref, index) => `${ref} = :set${index}`).join(', ')}`,
          ConditionExpression: `attribute_exists(pk) AND ${condition}`,
          ExpressionAttributeNames: { ...attr.map, ...conditionNames },
          ExpressionAttributeValues: { ...values, ...conditionValues },
        }),
      );
      return true;
    } catch (error) {
      if (isConflict(error)) return false;
      throw error;
    }
  }
}

/**
 * Relayed audio in an S3 bucket, under `music/<guild>/<job>/<chunk number>`. A helper uploads with
 * a form that only lets it write under its own job, for half an hour. The bucket deletes the
 * objects after a day.
 */
export class S3AudioRelayStore implements AudioRelayStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async uploadTarget(guildId: string, jobId: string): Promise<UploadTarget> {
    const keyPrefix = prefix(guildId, jobId);
    const { url, fields } = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      // "${filename}" makes the policy allow any key that starts with the prefix.
      Key: `${keyPrefix}\${filename}`,
      Conditions: [['content-length-range', 1, MAX_CHUNK_BYTES]],
      Expires: UPLOAD_WINDOW_SECONDS,
    });
    // The helper sets `key` itself for each chunk.
    const { key: _placeholder, ...rest } = fields;
    return { url, fields: rest, keyPrefix, maxChunkBytes: MAX_CHUNK_BYTES };
  }

  async read(guildId: string, jobId: string, index: number): Promise<Uint8Array | undefined> {
    try {
      const result = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: `${prefix(guildId, jobId)}${chunkName(index)}` }));
      return await result.Body?.transformToByteArray();
    } catch (error) {
      const name = (error as { name?: string } | undefined)?.name;
      // Not there. (Without permission to list the bucket, S3 says "access denied" for a missing key.)
      if (name === 'NoSuchKey' || name === 'NotFound' || name === 'AccessDenied') return undefined;
      throw error;
    }
  }
}

function helperKey(guildId: string, userId: string) {
  return { pk: `HELPER#${guildId}`, sk: `USER#${userId}` };
}

function jobKey(guildId: string, jobId: string) {
  return { pk: `MUSICJOB#${guildId}`, sk: `JOB#${jobId}` };
}

function prefix(guildId: string, jobId: string): string {
  return `music/${guildId}/${jobId}/`;
}

function toRegistration(item: Item): HelperRegistration {
  return {
    guildId: String(item.guildId),
    userId: String(item.userId),
    userName: String(item.userName),
    secretHash: String(item.secretHash),
    createdAt: Number(item.createdAt),
    lastSeenAt: item.lastSeenAt === undefined || item.lastSeenAt === null ? null : Number(item.lastSeenAt),
    version: item.version === undefined || item.version === null ? null : String(item.version),
  };
}

function toJob(item: Item): MusicJob {
  return {
    id: String(item.id),
    guildId: String(item.guildId),
    target: String(item.target),
    status: item.status as MusicJob['status'],
    createdAt: Number(item.createdAt),
    updatedAt: Number(item.updatedAt),
    helper: (item.helper as MusicJob['helper'] | undefined) ?? null,
    track: (item.track as RelayedTrack | undefined) ?? null,
    chunks: Number(item.chunks ?? 0),
    error: item.error === undefined || item.error === null ? null : String(item.error),
  };
}
