import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type SqliteDatabase = DatabaseSync;

/**
 * Ordered schema migrations. Append new entries; never edit an applied one.
 * Each runs inside a transaction and bumps `PRAGMA user_version`.
 */
const MIGRATIONS: readonly string[] = [
  // 1: voice sessions, transcripts, conversations, settings
  `
  CREATE TABLE voice_sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      TEXT    NOT NULL,
    channel_id    TEXT    NOT NULL,
    channel_name  TEXT    NOT NULL,
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER
  );
  CREATE INDEX idx_voice_sessions_guild_started ON voice_sessions (guild_id, started_at);

  CREATE TABLE transcript_segments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    INTEGER NOT NULL REFERENCES voice_sessions (id) ON DELETE CASCADE,
    guild_id      TEXT    NOT NULL,
    channel_id    TEXT    NOT NULL,
    speaker_id    TEXT    NOT NULL,
    speaker_name  TEXT    NOT NULL,
    is_assistant  INTEGER NOT NULL DEFAULT 0,
    text          TEXT    NOT NULL,
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER NOT NULL
  );
  CREATE INDEX idx_segments_guild_started   ON transcript_segments (guild_id, started_at);
  CREATE INDEX idx_segments_session_started ON transcript_segments (session_id, started_at);

  CREATE VIRTUAL TABLE transcript_fts USING fts5 (
    text, speaker_name,
    content = 'transcript_segments', content_rowid = 'id',
    tokenize = 'porter unicode61'
  );
  CREATE TRIGGER transcript_segments_ai AFTER INSERT ON transcript_segments BEGIN
    INSERT INTO transcript_fts (rowid, text, speaker_name) VALUES (new.id, new.text, new.speaker_name);
  END;
  CREATE TRIGGER transcript_segments_ad AFTER DELETE ON transcript_segments BEGIN
    INSERT INTO transcript_fts (transcript_fts, rowid, text, speaker_name) VALUES ('delete', old.id, old.text, old.speaker_name);
  END;
  CREATE TRIGGER transcript_segments_au AFTER UPDATE ON transcript_segments BEGIN
    INSERT INTO transcript_fts (transcript_fts, rowid, text, speaker_name) VALUES ('delete', old.id, old.text, old.speaker_name);
    INSERT INTO transcript_fts (rowid, text, speaker_name) VALUES (new.id, new.text, new.speaker_name);
  END;

  CREATE TABLE conversation_messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      TEXT    NOT NULL,
    user_id       TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
    content       TEXT    NOT NULL,
    search_text   TEXT    NOT NULL,
    modality      TEXT    NOT NULL CHECK (modality IN ('text', 'voice')),
    turn_start    INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX idx_conversation_user ON conversation_messages (guild_id, user_id, id);

  CREATE VIRTUAL TABLE conversation_fts USING fts5 (
    search_text,
    content = 'conversation_messages', content_rowid = 'id',
    tokenize = 'porter unicode61'
  );
  CREATE TRIGGER conversation_messages_ai AFTER INSERT ON conversation_messages BEGIN
    INSERT INTO conversation_fts (rowid, search_text) VALUES (new.id, new.search_text);
  END;
  CREATE TRIGGER conversation_messages_ad AFTER DELETE ON conversation_messages BEGIN
    INSERT INTO conversation_fts (conversation_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
  END;
  CREATE TRIGGER conversation_messages_au AFTER UPDATE ON conversation_messages BEGIN
    INSERT INTO conversation_fts (conversation_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
    INSERT INTO conversation_fts (rowid, search_text) VALUES (new.id, new.search_text);
  END;

  -- Where each person's active context window starts (messages with id >= window_start_id).
  CREATE TABLE conversation_threads (
    guild_id         TEXT    NOT NULL,
    user_id          TEXT    NOT NULL,
    window_start_id  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE user_settings (
    guild_id    TEXT    NOT NULL,
    user_id     TEXT    NOT NULL,
    style       TEXT    NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  `,
];

/**
 * Migrations for the long-term memory database (data/memories.db), kept in its own file so it can be
 * backed up, inspected or moved independently of transcripts and conversations.
 */
const MEMORY_MIGRATIONS: readonly string[] = [
  // 1: notes about people (subject_id = Discord user id) and about the server (subject_id NULL)
  `
  CREATE TABLE memories (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id        TEXT    NOT NULL,
    subject_id      TEXT,
    subject_name    TEXT    NOT NULL,
    text            TEXT    NOT NULL,
    source_user_id  TEXT    NOT NULL,
    source_name     TEXT    NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  CREATE INDEX idx_memories_subject ON memories (guild_id, subject_id, updated_at);

  CREATE VIRTUAL TABLE memories_fts USING fts5 (
    text, subject_name,
    content = 'memories', content_rowid = 'id',
    tokenize = 'porter unicode61'
  );
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (rowid, text, subject_name) VALUES (new.id, new.text, new.subject_name);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, text, subject_name) VALUES ('delete', old.id, old.text, old.subject_name);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, text, subject_name) VALUES ('delete', old.id, old.text, old.subject_name);
    INSERT INTO memories_fts (rowid, text, subject_name) VALUES (new.id, new.text, new.subject_name);
  END;
  `,
];

/** Opens (creating if needed) and migrates the long-term memory database at `path`. */
export function openMemoryDatabase(path: string): SqliteDatabase {
  return openSqlite(path, MEMORY_MIGRATIONS);
}

/** Opens (creating if needed) and migrates the SQLite database at `path`. Use `:memory:` for tests. */
export function openDatabase(path: string): SqliteDatabase {
  return openSqlite(path, MIGRATIONS);
}

function openSqlite(path: string, migrations: readonly string[]): SqliteDatabase {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') {
    // WAL lets the standalone memory MCP server read while the bot writes.
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
  }
  migrate(db, migrations);
  return db;
}

function migrate(db: SqliteDatabase, migrations: readonly string[]): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  if (current > migrations.length) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${migrations.length}). Upgrade the bot.`,
    );
  }
  for (let version = current; version < migrations.length; version++) {
    transaction(db, () => {
      db.exec(migrations[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

/** Runs `fn` inside an immediate transaction, rolling back if it throws. */
export function transaction<T>(db: SqliteDatabase, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
