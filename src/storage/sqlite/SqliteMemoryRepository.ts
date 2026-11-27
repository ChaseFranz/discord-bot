import type { Memory, MemoryRepository, NewMemory } from '../ports.js';
import type { SqliteDatabase } from './database.js';
import { toFtsQuery } from './fts.js';

interface MemoryRow {
  id: number;
  guild_id: string;
  subject_id: string | null;
  subject_name: string;
  text: string;
  source_user_id: string;
  source_name: string;
  created_at: number;
  updated_at: number;
}

/** Long-term memories in their own SQLite database (see openMemoryDatabase). */
export class SqliteMemoryRepository implements MemoryRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async add(memory: NewMemory): Promise<Memory> {
    const result = this.db
      .prepare(
        `INSERT INTO memories (guild_id, subject_id, subject_name, text, source_user_id, source_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.guildId,
        memory.subjectId,
        memory.subjectName,
        memory.text,
        memory.sourceUserId,
        memory.sourceName,
        memory.createdAt,
        memory.createdAt,
      );
    return { ...memory, id: Number(result.lastInsertRowid), updatedAt: memory.createdAt };
  }

  async get(guildId: string, id: number): Promise<Memory | undefined> {
    const row = this.db.prepare('SELECT * FROM memories WHERE guild_id = ? AND id = ?').get(guildId, id) as unknown as
      | MemoryRow
      | undefined;
    return row ? toMemory(row) : undefined;
  }

  async update(guildId: string, id: number, text: string, updatedAt: number): Promise<Memory | undefined> {
    const result = this.db
      .prepare('UPDATE memories SET text = ?, updated_at = ? WHERE guild_id = ? AND id = ?')
      .run(text, updatedAt, guildId, id);
    return Number(result.changes) > 0 ? this.get(guildId, id) : undefined;
  }

  async delete(guildId: string, id: number): Promise<boolean> {
    return Number(this.db.prepare('DELETE FROM memories WHERE guild_id = ? AND id = ?').run(guildId, id).changes) > 0;
  }

  async deleteAllAbout(guildId: string, subjectId: string): Promise<number> {
    return Number(this.db.prepare('DELETE FROM memories WHERE guild_id = ? AND subject_id = ?').run(guildId, subjectId).changes);
  }

  async listAbout(guildId: string, subjectIds: ReadonlyArray<string | null>, perSubject: number): Promise<Memory[]> {
    const memories: Memory[] = [];
    for (const subjectId of new Set(subjectIds)) {
      const rows = (
        subjectId === null
          ? this.db
              .prepare('SELECT * FROM memories WHERE guild_id = ? AND subject_id IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?')
              .all(guildId, perSubject)
          : this.db
              .prepare('SELECT * FROM memories WHERE guild_id = ? AND subject_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?')
              .all(guildId, subjectId, perSubject)
      ) as unknown as MemoryRow[];
      memories.push(...rows.map(toMemory));
    }
    return memories;
  }

  async countAbout(guildId: string, subjectId: string | null): Promise<number> {
    const row = (
      subjectId === null
        ? this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE guild_id = ? AND subject_id IS NULL').get(guildId)
        : this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE guild_id = ? AND subject_id = ?').get(guildId, subjectId)
    ) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  async search(guildId: string, query: string, limit: number): Promise<Memory[]> {
    const match = toFtsQuery(query);
    if (!match) return [];
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memories_fts f
           JOIN memories m ON m.id = f.rowid
          WHERE memories_fts MATCH ? AND m.guild_id = ?
          ORDER BY bm25(memories_fts) LIMIT ?`,
      )
      .all(match, guildId, limit) as unknown as MemoryRow[];
    return rows.map(toMemory);
  }
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    guildId: row.guild_id,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    text: row.text,
    sourceUserId: row.source_user_id,
    sourceName: row.source_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
