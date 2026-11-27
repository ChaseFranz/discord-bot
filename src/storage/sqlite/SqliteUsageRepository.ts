import type { UsageLine, UsageRepository } from '../ports.js';
import { transaction, type SqliteDatabase } from './database.js';

export class SqliteUsageRepository implements UsageRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async add(guildId: string, day: string, lines: readonly UsageLine[]): Promise<void> {
    if (lines.length === 0) return;
    const upsert = this.db.prepare(
      `INSERT INTO usage_daily (guild_id, day, metric, quantity, cost_usd) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, day, metric) DO UPDATE
         SET quantity = quantity + excluded.quantity, cost_usd = cost_usd + excluded.cost_usd`,
    );
    transaction(this.db, () => {
      for (const line of lines) upsert.run(guildId, day, line.metric, line.quantity, line.costUsd);
    });
  }

  async day(guildId: string, day: string): Promise<UsageLine[]> {
    const rows = this.db
      .prepare('SELECT metric, quantity, cost_usd FROM usage_daily WHERE guild_id = ? AND day = ? ORDER BY metric')
      .all(guildId, day) as unknown as Array<{ metric: string; quantity: number; cost_usd: number }>;
    return rows.map((row) => ({ metric: row.metric, quantity: row.quantity, costUsd: row.cost_usd }));
  }

  async dailyTotals(guildId: string, fromDay: string, toDay: string): Promise<Array<{ day: string; costUsd: number }>> {
    const rows = this.db
      .prepare(
        `SELECT day, SUM(cost_usd) AS cost FROM usage_daily
          WHERE guild_id = ? AND day >= ? AND day <= ?
          GROUP BY day ORDER BY day`,
      )
      .all(guildId, fromDay, toDay) as unknown as Array<{ day: string; cost: number }>;
    return rows.map((row) => ({ day: row.day, costUsd: row.cost }));
  }
}
