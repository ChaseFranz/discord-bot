import type { SettingsRepository, UserScope, UserSettings } from '../ports.js';
import type { SqliteDatabase } from './database.js';
import { systemClock, type Clock } from '../../util/time.js';

export class SqliteSettingsRepository implements SettingsRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock = systemClock,
  ) {}

  async get(scope: UserScope): Promise<UserSettings | undefined> {
    const row = this.db
      .prepare('SELECT style FROM user_settings WHERE guild_id = ? AND user_id = ?')
      .get(scope.guildId, scope.userId) as { style: string } | undefined;
    return row ? { style: row.style } : undefined;
  }

  async set(scope: UserScope, settings: UserSettings): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO user_settings (guild_id, user_id, style, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET style = excluded.style, updated_at = excluded.updated_at`,
      )
      .run(scope.guildId, scope.userId, settings.style, this.clock());
  }
}
