import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type {
  AppendTurnInput,
  ConversationRepository,
  ConversationSearchHit,
  Modality,
  StoredConversationMessage,
  UserScope,
  WindowPolicy,
} from '../ports.js';
import { transaction, type SqliteDatabase } from './database.js';
import { toFtsQuery } from './fts.js';

interface MessageRow {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  modality: Modality;
  turn_start: number;
  created_at: number;
}

interface SearchRow {
  id: number;
  role: 'user' | 'assistant';
  modality: Modality;
  created_at: number;
  search_text: string;
  window_start_id: number;
}

const SEARCH_TEXT_LIMIT = 600;

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async loadActive(scope: UserScope): Promise<StoredConversationMessage[]> {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.role, m.content, m.modality, m.turn_start, m.created_at
           FROM conversation_messages m
          WHERE m.guild_id = ? AND m.user_id = ?
            AND m.id >= ?
          ORDER BY m.id`,
      )
      .all(scope.guildId, scope.userId, this.windowStart(scope)) as unknown as MessageRow[];
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: JSON.parse(row.content) as BetaContentBlockParam[],
      modality: row.modality,
      createdAt: row.created_at,
    }));
  }

  async appendTurn(input: AppendTurnInput): Promise<void> {
    const { scope, modality, messages, createdAt } = input;
    if (messages.length === 0) return;
    if (messages[0]!.role !== 'user') {
      throw new Error('A turn must start with the user message');
    }
    const insert = this.db.prepare(
      `INSERT INTO conversation_messages (guild_id, user_id, role, content, search_text, modality, turn_start, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    transaction(this.db, () => {
      messages.forEach((message, index) => {
        insert.run(
          scope.guildId,
          scope.userId,
          message.role,
          JSON.stringify(message.content),
          extractSearchText(message.content),
          modality,
          index === 0 ? 1 : 0,
          createdAt,
        );
      });
    });
  }

  async trimWindow(scope: UserScope, policy: WindowPolicy): Promise<number> {
    if (policy.keepMessages > policy.maxMessages) {
      throw new RangeError('keepMessages must not exceed maxMessages');
    }
    const rows = this.db
      .prepare(
        `SELECT id, turn_start FROM conversation_messages
          WHERE guild_id = ? AND user_id = ? AND id >= ?
          ORDER BY id`,
      )
      .all(scope.guildId, scope.userId, this.windowStart(scope)) as unknown as Array<{ id: number; turn_start: number }>;

    if (rows.length <= policy.maxMessages) return 0;

    // Earliest turn boundary that leaves at most keepMessages in the window.
    let cutIndex = rows.findIndex((row, index) => row.turn_start === 1 && rows.length - index <= policy.keepMessages);
    if (cutIndex === -1) {
      // A single turn is longer than keepMessages: keep just the latest turn.
      cutIndex = rows.map((row) => row.turn_start).lastIndexOf(1);
    }
    if (cutIndex <= 0) return 0;

    this.db
      .prepare(
        `INSERT INTO conversation_threads (guild_id, user_id, window_start_id) VALUES (?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET window_start_id = excluded.window_start_id
         WHERE excluded.window_start_id > conversation_threads.window_start_id`,
      )
      .run(scope.guildId, scope.userId, rows[cutIndex]!.id);
    return cutIndex;
  }

  async search(scope: UserScope, query: string, limit: number): Promise<ConversationSearchHit[]> {
    const match = toFtsQuery(query);
    if (!match) return [];
    const rows = this.db
      .prepare(
        `SELECT m.id, m.role, m.modality, m.created_at, m.search_text,
                COALESCE(t.window_start_id, 0) AS window_start_id
           FROM conversation_fts f
           JOIN conversation_messages m ON m.id = f.rowid
           LEFT JOIN conversation_threads t ON t.guild_id = m.guild_id AND t.user_id = m.user_id
          WHERE conversation_fts MATCH ?
            AND m.guild_id = ? AND m.user_id = ?
          ORDER BY bm25(conversation_fts)
          LIMIT ?`,
      )
      .all(match, scope.guildId, scope.userId, limit) as unknown as SearchRow[];
    return rows.map((row) => ({
      messageId: row.id,
      role: row.role,
      modality: row.modality,
      createdAt: row.created_at,
      text: row.search_text.length > SEARCH_TEXT_LIMIT ? `${row.search_text.slice(0, SEARCH_TEXT_LIMIT)}…` : row.search_text,
      archived: row.id < row.window_start_id,
    }));
  }

  async reset(scope: UserScope): Promise<void> {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM conversation_messages WHERE guild_id = ? AND user_id = ?').run(scope.guildId, scope.userId);
      this.db.prepare('DELETE FROM conversation_threads WHERE guild_id = ? AND user_id = ?').run(scope.guildId, scope.userId);
    });
  }

  async pruneArchivedBefore(cutoff: number): Promise<number> {
    const result = this.db
      .prepare(
        `DELETE FROM conversation_messages
          WHERE created_at < ?
            AND id < COALESCE(
                  (SELECT t.window_start_id FROM conversation_threads t
                    WHERE t.guild_id = conversation_messages.guild_id AND t.user_id = conversation_messages.user_id),
                  0)`,
      )
      .run(cutoff);
    return Number(result.changes);
  }

  private windowStart(scope: UserScope): number {
    const row = this.db
      .prepare('SELECT window_start_id FROM conversation_threads WHERE guild_id = ? AND user_id = ?')
      .get(scope.guildId, scope.userId) as { window_start_id: number } | undefined;
    return row?.window_start_id ?? 0;
  }
}

/** Plain text used for full-text search: the text blocks of a message. Tool plumbing is skipped. */
export function extractSearchText(content: readonly BetaContentBlockParam[]): string {
  return content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
}
