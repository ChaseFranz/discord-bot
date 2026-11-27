import { GetCommand, PutCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type {
  NewTranscriptSegment,
  TranscriptFilters,
  TranscriptRangeQuery,
  TranscriptRepository,
  TranscriptSearchHit,
  TranscriptSearchQuery,
  TranscriptSegment,
  VoiceSessionRecord,
  VoiceSessionSummary,
} from '../ports.js';
import { queryTerms, rankByRelevance } from '../search/textSearch.js';
import { MAX_KEY_NUMBER, expiryAfter, isConflict, names, pad, putWithNewId, queryAll, queryUntil, type Item } from './dynamo.js';
import { GSI1, GSI2 } from './schema.js';

const META = 'META';
const SEGMENT = 'SEG#';
const STATUS_OPEN = 'SESSION_STATUS#OPEN';
const STATUS_UNRECAPPED = 'SESSION_STATUS#UNRECAPPED';
const COUNTER = 'SESSION';

/**
 * Voice sessions and their transcript lines. A session is a META item under `SESSION#<id>` with
 * running totals (line count, speakers, last activity); its lines sit in the same partition,
 * sorted by time. Index gsi1 lists a guild's sessions and lines in time order (`TRANSCRIPT#<guild>`);
 * index gsi2 tracks sessions that are still open or still need a recap. Keyword search ranks the
 * candidate lines in code.
 */
export class DynamoTranscriptRepository implements TranscriptRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly options: { retentionDays: number },
  ) {}

  async startSession(input: Omit<VoiceSessionRecord, 'id' | 'endedAt'>): Promise<VoiceSessionRecord> {
    const id = await putWithNewId(this.doc, this.table, COUNTER, (id) => ({
      pk: sessionKey(id),
      sk: META,
      id,
      guildId: input.guildId,
      channelId: input.channelId,
      channelName: input.channelName,
      startedAt: input.startedAt,
      segmentCount: 0,
      nextSegment: 0,
      gsi1pk: guildKey(input.guildId),
      gsi1sk: `SESSION#${pad(input.startedAt)}#${pad(id)}`,
      gsi2pk: STATUS_OPEN,
      gsi2sk: `${pad(input.startedAt)}#${pad(id)}`,
    }));
    return { ...input, id, endedAt: null };
  }

  async endSession(sessionId: number, endedAt: number): Promise<void> {
    await this.close(sessionId, endedAt);
  }

  async endOpenSessions(endedAt: number): Promise<number> {
    const open = await queryAll(this.doc, {
      TableName: this.table,
      IndexName: GSI2,
      KeyConditionExpression: 'gsi2pk = :status',
      ExpressionAttributeValues: { ':status': STATUS_OPEN },
    });
    let closed = 0;
    for (const session of open) {
      // At its last recorded activity (or its start), so a crash doesn't make a session look hours long.
      const lastActivity = session.lastActivityAt === undefined ? Number(session.startedAt) : Number(session.lastActivityAt);
      if (await this.close(Number(session.id), Math.min(endedAt, lastActivity))) closed++;
    }
    return closed;
  }

  async appendSegment(segment: NewTranscriptSegment): Promise<TranscriptSegment> {
    // The assistant isn't a participant; DynamoDB rejects names an expression doesn't use, so
    // "participants" is only named for people.
    const attr = segment.isAssistant
      ? names('segmentCount', 'nextSegment', 'lastActivityAt')
      : names('segmentCount', 'nextSegment', 'lastActivityAt', 'participants');
    const [segmentCount, nextSegment, lastActivityAt, participants] = attr.refs;
    const add = [`${segmentCount} :one`, `${nextSegment} :one`, ...(participants ? [`${participants} :speaker`] : [])];
    const updated = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: sessionKey(segment.sessionId), sk: META },
        UpdateExpression: `ADD ${add.join(', ')} SET ${lastActivityAt} = :at`,
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: attr.map,
        ExpressionAttributeValues: {
          ':one': 1,
          ':at': segment.endedAt,
          ...(segment.isAssistant ? {} : { ':speaker': new Set([segment.speakerName]) }),
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    const id = Number(updated.Attributes?.nextSegment);
    const channelName = String(updated.Attributes?.channelName ?? '');
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          pk: sessionKey(segment.sessionId),
          sk: segmentSortKey(segment.startedAt, id),
          ...segment,
          id,
          channelName,
          gsi1pk: guildKey(segment.guildId),
          gsi1sk: `${SEGMENT}${pad(segment.startedAt)}#${pad(segment.sessionId)}#${pad(id)}`,
          expiresAt: expiryAfter(segment.startedAt, this.options.retentionDays),
        },
      }),
    );
    return { ...segment, id };
  }

  async recentSegments(sessionId: number, since: number, limit: number): Promise<TranscriptSegment[]> {
    const result = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':pk': sessionKey(sessionId), ':from': `${SEGMENT}${pad(since)}`, ':to': `${SEGMENT}~` },
        ScanIndexForward: false,
        Limit: limit,
        ConsistentRead: true,
      }),
    );
    return ((result.Items ?? []) as Item[]).reverse().map(toSegment);
  }

  async search(query: TranscriptSearchQuery): Promise<TranscriptSearchHit[]> {
    if (queryTerms(query.query).length === 0) return [];
    const candidates = await queryAll(this.doc, this.segmentQuery(query, 'oldest_first'));
    const segments = candidates.map(toSegmentWithChannel).filter((segment) => matchesSpeaker(segment, query.speaker));
    const hits = rankByRelevance(
      segments,
      query.query,
      [
        { text: (segment) => segment.text, weight: 1 },
        { text: (segment) => segment.speakerName, weight: 0.5 },
      ],
      query.limit,
    );
    return Promise.all(
      hits.map(async ({ channelName, ...hit }) => ({ hit, channelName, context: await this.contextAround(hit, query.contextSegments) })),
    );
  }

  async readRange(query: TranscriptRangeQuery): Promise<{ segments: TranscriptSegment[]; hasMore: boolean }> {
    const items = await queryUntil(
      this.doc,
      this.segmentQuery(query, query.order),
      query.limit + 1,
      (item) => matchesSpeaker(toSegment(item), query.speaker),
    );
    const page = items.slice(0, query.limit).map(toSegment);
    if (query.order === 'newest_first') page.reverse();
    return { segments: page, hasMore: items.length > query.limit };
  }

  async listSessions(guildId: string, options: { since?: number; limit: number }): Promise<VoiceSessionSummary[]> {
    const since = options.since;
    const items = await queryUntil(
      this.doc,
      {
        TableName: this.table,
        IndexName: GSI1,
        KeyConditionExpression: 'gsi1pk = :guild AND begins_with(gsi1sk, :prefix)',
        ExpressionAttributeValues: { ':guild': guildKey(guildId), ':prefix': 'SESSION#' },
        ScanIndexForward: false,
      },
      options.limit,
      (item) => since === undefined || item.endedAt === undefined || Number(item.endedAt) >= since,
    );
    return items.map((item) => ({
      ...toSession(item),
      segmentCount: Number(item.segmentCount ?? 0),
      participants: [...((item.participants as Set<string> | undefined) ?? [])].sort(),
      lastActivityAt: item.lastActivityAt === undefined ? null : Number(item.lastActivityAt),
      recap: typeof item.recap === 'string' && item.recap.trim().length > 0 ? item.recap : null,
    }));
  }

  async getSession(sessionId: number): Promise<VoiceSessionRecord | undefined> {
    const result = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: sessionKey(sessionId), sk: META }, ConsistentRead: true }));
    return result.Item ? toSession(result.Item) : undefined;
  }

  async setRecap(sessionId: number, recap: string, recappedAt: number): Promise<void> {
    const attr = names('recap', 'recappedAt');
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: sessionKey(sessionId), sk: META },
          UpdateExpression: `SET ${attr.refs[0]} = :recap, ${attr.refs[1]} = :at REMOVE gsi2pk, gsi2sk`,
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: attr.map,
          ExpressionAttributeValues: { ':recap': recap, ':at': recappedAt },
        }),
      );
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }

  async sessionsNeedingRecap(since: number, minSegments: number): Promise<VoiceSessionRecord[]> {
    const items = await queryAll(this.doc, {
      TableName: this.table,
      IndexName: GSI2,
      KeyConditionExpression: 'gsi2pk = :status AND gsi2sk >= :since',
      ExpressionAttributeValues: { ':status': STATUS_UNRECAPPED, ':since': pad(since) },
    });
    return items.filter((item) => Number(item.segmentCount ?? 0) >= minSegments).map(toSession);
  }

  /** DynamoDB deletes expired lines and sessions itself (TTL), so there is nothing to sweep. */
  async pruneBefore(_cutoff: number): Promise<number> {
    return 0;
  }

  /** Marks a session ended (once). Returns whether it was still open. */
  private async close(sessionId: number, endedAt: number): Promise<boolean> {
    const attr = names('endedAt', 'expiresAt');
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: sessionKey(sessionId), sk: META },
          UpdateExpression: `SET ${attr.refs[0]} = :ended, gsi2pk = :status${
            this.options.retentionDays > 0 ? `, ${attr.refs[1]} = :expires` : ''
          }`,
          ConditionExpression: `attribute_exists(pk) AND attribute_not_exists(${attr.refs[0]})`,
          ExpressionAttributeNames: this.options.retentionDays > 0 ? attr.map : { [attr.refs[0]!]: 'endedAt' },
          ExpressionAttributeValues: {
            ':ended': endedAt,
            ':status': STATUS_UNRECAPPED,
            ...(this.options.retentionDays > 0 ? { ':expires': expiryAfter(endedAt, this.options.retentionDays) } : {}),
          },
        }),
      );
      return true;
    } catch (error) {
      if (isConflict(error)) return false;
      throw error;
    }
  }

  /**
   * The query for a guild's lines (or one session's) between the filters' times. The guild filter
   * matters for a session query: a session id alone could belong to any guild.
   */
  private segmentQuery(filters: TranscriptFilters, order: 'oldest_first' | 'newest_first') {
    const from = `${SEGMENT}${pad(filters.since ?? 0)}`;
    const to = `${SEGMENT}${pad(filters.until ?? MAX_KEY_NUMBER)}#~`;
    const guild = names('guildId');
    const common = {
      TableName: this.table,
      ScanIndexForward: order === 'oldest_first',
      FilterExpression: `${guild.refs[0]} = :guild`,
      ExpressionAttributeNames: guild.map,
    };
    if (filters.sessionId !== undefined) {
      return {
        ...common,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':pk': sessionKey(filters.sessionId), ':from': from, ':to': to, ':guild': filters.guildId },
        ConsistentRead: true,
      };
    }
    return {
      ...common,
      IndexName: GSI1,
      KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':pk': guildKey(filters.guildId), ':from': from, ':to': to, ':guild': filters.guildId },
    };
  }

  private async contextAround(hit: TranscriptSegment, count: number): Promise<TranscriptSegment[]> {
    if (count <= 0) return [hit];
    const sk = segmentSortKey(hit.startedAt, hit.id);
    // Lines sort after the session's META item, so "before" is bounded by the line prefix; both
    // bounds of BETWEEN are inclusive, hence one extra item and dropping the hit itself.
    const side = async (before: boolean) => {
      const result = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: before ? 'pk = :pk AND sk BETWEEN :floor AND :sk' : 'pk = :pk AND sk > :sk',
          ExpressionAttributeValues: { ':pk': sessionKey(hit.sessionId), ':sk': sk, ...(before ? { ':floor': SEGMENT } : {}) },
          ScanIndexForward: !before,
          Limit: count + 1,
          ConsistentRead: true,
        }),
      );
      return ((result.Items ?? []) as Item[]).filter((item) => item.sk !== sk).slice(0, count).map(toSegment);
    };
    const [before, after] = await Promise.all([side(true), side(false)]);
    return [...before.reverse(), hit, ...after];
  }
}

function sessionKey(sessionId: number): string {
  return `SESSION#${sessionId}`;
}

function guildKey(guildId: string): string {
  return `TRANSCRIPT#${guildId}`;
}

function segmentSortKey(startedAt: number, id: number): string {
  return `${SEGMENT}${pad(startedAt)}#${pad(id)}`;
}

function matchesSpeaker(segment: TranscriptSegment, speaker: string | undefined): boolean {
  const wanted = speaker?.trim();
  if (!wanted) return true;
  return segment.speakerId === wanted || segment.speakerName.toLowerCase().includes(wanted.toLowerCase());
}

function toSegment(item: Item): TranscriptSegment {
  return {
    id: Number(item.id),
    sessionId: Number(item.sessionId),
    guildId: String(item.guildId),
    channelId: String(item.channelId),
    speakerId: String(item.speakerId),
    speakerName: String(item.speakerName),
    isAssistant: item.isAssistant === true,
    text: String(item.text),
    startedAt: Number(item.startedAt),
    endedAt: Number(item.endedAt),
  };
}

function toSegmentWithChannel(item: Item): TranscriptSegment & { channelName: string } {
  return { ...toSegment(item), channelName: String(item.channelName ?? '') };
}

function toSession(item: Item): VoiceSessionRecord {
  return {
    id: Number(item.id),
    guildId: String(item.guildId),
    channelId: String(item.channelId),
    channelName: String(item.channelName),
    startedAt: Number(item.startedAt),
    endedAt: item.endedAt === undefined ? null : Number(item.endedAt),
  };
}
