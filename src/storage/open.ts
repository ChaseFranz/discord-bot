import type {
  ConversationRepository,
  MemoryRepository,
  ReminderRepository,
  SettingsRepository,
  TranscriptRepository,
  UsageRepository,
} from './ports.js';
import { DynamoConversationRepository } from './dynamodb/DynamoConversationRepository.js';
import { DynamoMemoryRepository } from './dynamodb/DynamoMemoryRepository.js';
import { DynamoReminderRepository } from './dynamodb/DynamoReminderRepository.js';
import { DynamoSettingsRepository } from './dynamodb/DynamoSettingsRepository.js';
import { DynamoTranscriptRepository } from './dynamodb/DynamoTranscriptRepository.js';
import { DynamoUsageRepository } from './dynamodb/DynamoUsageRepository.js';
import { createDocumentClient } from './dynamodb/dynamo.js';
import { openDatabase, openMemoryDatabase } from './sqlite/database.js';
import { SqliteConversationRepository } from './sqlite/SqliteConversationRepository.js';
import { SqliteMemoryRepository } from './sqlite/SqliteMemoryRepository.js';
import { SqliteReminderRepository } from './sqlite/SqliteReminderRepository.js';
import { SqliteSettingsRepository } from './sqlite/SqliteSettingsRepository.js';
import { SqliteTranscriptRepository } from './sqlite/SqliteTranscriptRepository.js';
import { SqliteUsageRepository } from './sqlite/SqliteUsageRepository.js';
import type { Clock } from '../util/time.js';

/** Every repository the bot uses, from one backend. */
export interface Storage {
  conversations: ConversationRepository;
  transcripts: TranscriptRepository;
  settings: SettingsRepository;
  memories: MemoryRepository;
  reminders: ReminderRepository;
  usage: UsageRepository;
  /**
   * True when old data expires by itself (DynamoDB TTL); false when the app has to run the
   * retention sweep (SQLite).
   */
  expiresOnItsOwn: boolean;
  close(): Promise<void>;
}

export type StorageConfig =
  | { kind: 'sqlite'; databasePath: string; memoryDatabasePath: string }
  | { kind: 'dynamodb'; region: string; endpoint?: string; table: string; memoryTable: string };

/** Opens the configured backend: SQLite files on this computer, or DynamoDB tables. */
export function openStorage(config: StorageConfig, options: { retentionDays: number; clock: Clock }): Storage {
  if (config.kind === 'sqlite') {
    const db = openDatabase(config.databasePath);
    // Long-term notes about people live in their own database.
    const memoryDb = openMemoryDatabase(config.memoryDatabasePath);
    return {
      conversations: new SqliteConversationRepository(db),
      transcripts: new SqliteTranscriptRepository(db),
      settings: new SqliteSettingsRepository(db, options.clock),
      memories: new SqliteMemoryRepository(memoryDb),
      reminders: new SqliteReminderRepository(db, options.clock),
      usage: new SqliteUsageRepository(db),
      expiresOnItsOwn: false,
      async close() {
        db.close();
        memoryDb.close();
      },
    };
  }

  const doc = createDocumentClient({ region: config.region, endpoint: config.endpoint });
  const retention = { retentionDays: options.retentionDays };
  return {
    conversations: new DynamoConversationRepository(doc, config.table, retention),
    transcripts: new DynamoTranscriptRepository(doc, config.table, retention),
    settings: new DynamoSettingsRepository(doc, config.table, options.clock),
    memories: new DynamoMemoryRepository(doc, config.memoryTable),
    reminders: new DynamoReminderRepository(doc, config.table, retention, options.clock),
    usage: new DynamoUsageRepository(doc, config.table),
    expiresOnItsOwn: true,
    async close() {
      doc.destroy();
    },
  };
}
