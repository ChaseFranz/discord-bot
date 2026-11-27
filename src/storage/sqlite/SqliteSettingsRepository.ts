import { DEFAULT_USER_SETTINGS, type PrivacyLevel, type SettingsRepository, type UserScope, type UserSettings } from '../ports.js';
import type { SqliteDatabase } from './database.js';
import { systemClock, type Clock } from '../../util/time.js';

interface SettingsRow {
  style: string;
  privacy: PrivacyLevel;
}

export class SqliteSettingsRepository implements SettingsRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock = systemClock,
  ) {}

  async get(scope: UserScope): Promise<UserSettings | undefined> {
    const row = this.db
      .prepare('SELECT style, privacy FROM user_settings WHERE guild_id = ? AND user_id = ?')
      .get(scope.guildId, scope.userId) as SettingsRow | undefined;
    return row ? { style: row.style, privacy: row.privacy } : undefined;
  }

  async update(scope: UserScope, changes: Partial<UserSettings>): Promise<UserSettings> {
    const next: UserSettings = { ...DEFAULT_USER_SETTINGS, ...(await this.get(scope)), ...changes };
    this.db
      .prepare(
        `INSERT INTO user_settings (guild_id, user_id, style, privacy, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE
           SET style = excluded.style, privacy = excluded.privacy, updated_at = excluded.updated_at`,
      )
      .run(scope.guildId, scope.userId, next.style, next.privacy, this.clock());
    return next;
  }
}
