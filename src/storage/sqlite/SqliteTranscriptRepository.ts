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
import { transaction, type SqliteDatabase } from './database.js';
import { escapeLike, toFtsQuery } from './fts.js';

type SqlValue = string | number | null;

interface SegmentRow {
  id: number;
  session_id: number;
  guild_id: string;
  channel_id: string;
  speaker_id: string;
  speaker_name: string;
  is_assistant: number;
  text: string;
  started_at: number;
  ended_at: number;
}

interface SessionRow {
  id: number;
  guild_id: string;
  channel_id: string;
  channel_name: string;
  started_at: number;
  ended_at: number | null;
  recap: string | null;
}

const PARTICIPANT_SEPARATOR = '\u001f';

export class SqliteTranscriptRepository implements TranscriptRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async startSession(input: Omit<VoiceSessionRecord, 'id' | 'endedAt'>): Promise<VoiceSessionRecord> {
    const result = this.db
      .prepare('INSERT INTO voice_sessions (guild_id, channel_id, channel_name, started_at) VALUES (?, ?, ?, ?)')
      .run(input.guildId, input.channelId, input.channelName, input.startedAt);
    return { ...input, id: Number(result.lastInsertRowid), endedAt: null };
  }

  async endSession(sessionId: number, endedAt: number): Promise<void> {
    this.db.prepare('UPDATE voice_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(endedAt, sessionId);
  }

  async endOpenSessions(endedAt: number): Promise<number> {
    // Close each open session at its last recorded activity (or its start) rather than "now",
    // so a crash doesn't make a session look hours long.
    const result = this.db
      .prepare(
        `UPDATE voice_sessions
            SET ended_at = MIN(?, COALESCE((SELECT MAX(s.ended_at) FROM transcript_segments s WHERE s.session_id = voice_sessions.id), started_at))
          WHERE ended_at IS NULL`,
      )
      .run(endedAt);
    return Number(result.changes);
  }

  async appendSegment(segment: NewTranscriptSegment): Promise<TranscriptSegment> {
    const result = this.db
      .prepare(
        `INSERT INTO transcript_segments
           (session_id, guild_id, channel_id, speaker_id, speaker_name, is_assistant, text, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        segment.sessionId,
        segment.guildId,
        segment.channelId,
        segment.speakerId,
        segment.speakerName,
        segment.isAssistant ? 1 : 0,
        segment.text,
        segment.startedAt,
        segment.endedAt,
      );
    return { ...segment, id: Number(result.lastInsertRowid) };
  }

  async recentSegments(sessionId: number, since: number, limit: number): Promise<TranscriptSegment[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM transcript_segments
          WHERE session_id = ? AND started_at >= ?
          ORDER BY started_at DESC, id DESC
          LIMIT ?`,
      )
      .all(sessionId, since, limit) as unknown as SegmentRow[];
    return rows.reverse().map(toSegment);
  }

  async search(query: TranscriptSearchQuery): Promise<TranscriptSearchHit[]> {
    const match = toFtsQuery(query.query);
    if (!match) return [];
    const filters = buildFilters('s', query);
    const rows = this.db
      .prepare(
        `SELECT s.*, v.channel_name AS session_channel_name
           FROM transcript_fts f
           JOIN transcript_segments s ON s.id = f.rowid
           JOIN voice_sessions v ON v.id = s.session_id
          WHERE transcript_fts MATCH ? AND ${filters.sql}
          ORDER BY bm25(transcript_fts, 1.0, 0.5)
          LIMIT ?`,
      )
      .all(match, ...filters.params, query.limit) as unknown as Array<SegmentRow & { session_channel_name: string }>;

    return rows.map((row) => {
      const hit = toSegment(row);
      return { hit, channelName: row.session_channel_name, context: this.contextAround(hit, query.contextSegments) };
    });
  }

  async readRange(query: TranscriptRangeQuery): Promise<{ segments: TranscriptSegment[]; hasMore: boolean }> {
    const filters = buildFilters('s', query);
    const direction = query.order === 'oldest_first' ? 'ASC' : 'DESC';
    const rows = this.db
      .prepare(
        `SELECT s.* FROM transcript_segments s
          WHERE ${filters.sql}
          ORDER BY s.started_at ${direction}, s.id ${direction}
          LIMIT ?`,
      )
      .all(...filters.params, query.limit + 1) as unknown as SegmentRow[];
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit).map(toSegment);
    if (query.order === 'newest_first') page.reverse();
    return { segments: page, hasMore };
  }

  async listSessions(guildId: string, options: { since?: number; limit: number }): Promise<VoiceSessionSummary[]> {
    const params: SqlValue[] = [guildId];
    let sinceClause = '';
    if (options.since !== undefined) {
      sinceClause = 'AND (v.ended_at IS NULL OR v.ended_at >= ?)';
      params.push(options.since);
    }
    params.push(options.limit);
    const rows = this.db
      .prepare(
        `SELECT v.*,
                (SELECT COUNT(*) FROM transcript_segments s WHERE s.session_id = v.id) AS segment_count,
                (SELECT MAX(s.ended_at) FROM transcript_segments s WHERE s.session_id = v.id) AS last_activity_at,
                (SELECT group_concat(name, '${PARTICIPANT_SEPARATOR}')
                   FROM (SELECT DISTINCT s.speaker_name AS name FROM transcript_segments s
                          WHERE s.session_id = v.id AND s.is_assistant = 0)) AS participants
           FROM voice_sessions v
          WHERE v.guild_id = ? ${sinceClause}
          ORDER BY v.started_at DESC
          LIMIT ?`,
      )
      .all(...params) as unknown as Array<
      SessionRow & { segment_count: number; last_activity_at: number | null; participants: string | null }
    >;
    return rows.map((row) => ({
      ...toSession(row),
      segmentCount: row.segment_count,
      lastActivityAt: row.last_activity_at,
      participants: row.participants ? row.participants.split(PARTICIPANT_SEPARATOR).sort() : [],
      recap: row.recap && row.recap.trim().length > 0 ? row.recap : null,
    }));
  }

  async getSession(sessionId: number): Promise<VoiceSessionRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM voice_sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  async setRecap(sessionId: number, recap: string, recappedAt: number): Promise<void> {
    this.db.prepare('UPDATE voice_sessions SET recap = ?, recapped_at = ? WHERE id = ?').run(recap, recappedAt, sessionId);
  }

  async sessionsNeedingRecap(since: number, minSegments: number): Promise<VoiceSessionRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT v.* FROM voice_sessions v
          WHERE v.ended_at IS NOT NULL AND v.recap IS NULL AND v.started_at >= ?
            AND (SELECT COUNT(*) FROM transcript_segments s WHERE s.session_id = v.id) >= ?
          ORDER BY v.started_at ASC`,
      )
      .all(since, minSegments) as unknown as SessionRow[];
    return rows.map(toSession);
  }

  async pruneBefore(cutoff: number): Promise<number> {
    return transaction(this.db, () => {
      const deleted = this.db.prepare('DELETE FROM transcript_segments WHERE started_at < ?').run(cutoff);
      this.db
        .prepare(
          `DELETE FROM voice_sessions
            WHERE ended_at IS NOT NULL AND ended_at < ?
              AND NOT EXISTS (SELECT 1 FROM transcript_segments s WHERE s.session_id = voice_sessions.id)`,
        )
        .run(cutoff);
      return Number(deleted.changes);
    });
  }

  private contextAround(hit: TranscriptSegment, count: number): TranscriptSegment[] {
    if (count <= 0) return [hit];
    const before = this.db
      .prepare(
        `SELECT * FROM transcript_segments
          WHERE session_id = ? AND (started_at < ? OR (started_at = ? AND id < ?))
          ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(hit.sessionId, hit.startedAt, hit.startedAt, hit.id, count) as unknown as SegmentRow[];
    const after = this.db
      .prepare(
        `SELECT * FROM transcript_segments
          WHERE session_id = ? AND (started_at > ? OR (started_at = ? AND id > ?))
          ORDER BY started_at ASC, id ASC LIMIT ?`,
      )
      .all(hit.sessionId, hit.startedAt, hit.startedAt, hit.id, count) as unknown as SegmentRow[];
    return [...before.reverse().map(toSegment), hit, ...after.map(toSegment)];
  }
}

function buildFilters(alias: string, filters: TranscriptFilters): { sql: string; params: SqlValue[] } {
  const clauses: string[] = [`${alias}.guild_id = ?`];
  const params: SqlValue[] = [filters.guildId];
  if (filters.sessionId !== undefined) {
    clauses.push(`${alias}.session_id = ?`);
    params.push(filters.sessionId);
  }
  if (filters.speaker !== undefined && filters.speaker.trim() !== '') {
    const speaker = filters.speaker.trim();
    clauses.push(`(${alias}.speaker_id = ? OR ${alias}.speaker_name LIKE ? ESCAPE '\\')`);
    params.push(speaker, `%${escapeLike(speaker)}%`);
  }
  if (filters.since !== undefined) {
    clauses.push(`${alias}.started_at >= ?`);
    params.push(filters.since);
  }
  if (filters.until !== undefined) {
    clauses.push(`${alias}.started_at <= ?`);
    params.push(filters.until);
  }
  return { sql: clauses.join(' AND '), params };
}

function toSegment(row: SegmentRow): TranscriptSegment {
  return {
    id: row.id,
    sessionId: row.session_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    speakerId: row.speaker_id,
    speakerName: row.speaker_name,
    isAssistant: row.is_assistant === 1,
    text: row.text,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function toSession(row: SessionRow): VoiceSessionRecord {
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}
