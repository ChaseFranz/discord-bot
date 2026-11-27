import type { NewReminder, Reminder, ReminderAudience, ReminderKind, ReminderRepository, ReminderStatus, RepeatRule } from '../ports.js';
import { systemClock, type Clock } from '../../util/time.js';
import type { SqliteDatabase } from './database.js';

interface ReminderRow {
  id: number;
  guild_id: string;
  user_id: string;
  user_name: string;
  kind: ReminderKind;
  message: string;
  audience: ReminderAudience;
  channel_id: string;
  due_at: number;
  repeat: string | null;
  time_zone: string;
  duration_ms: number | null;
  created_at: number;
  fired_count: number;
  last_fired_at: number | null;
  status: ReminderStatus;
}

export class SqliteReminderRepository implements ReminderRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(reminder: NewReminder): Promise<Reminder> {
    const result = this.db
      .prepare(
        `INSERT INTO reminders
           (guild_id, user_id, user_name, kind, message, audience, channel_id, due_at, repeat, time_zone, duration_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reminder.guildId,
        reminder.userId,
        reminder.userName,
        reminder.kind,
        reminder.message,
        reminder.audience,
        reminder.channelId,
        reminder.dueAt,
        reminder.repeat ? JSON.stringify(reminder.repeat) : null,
        reminder.timeZone,
        reminder.durationMs,
        reminder.createdAt,
        reminder.createdAt,
      );
    return { ...reminder, id: Number(result.lastInsertRowid), firedCount: 0, lastFiredAt: null, status: 'active' };
  }

  async get(guildId: string, id: number): Promise<Reminder | undefined> {
    const row = this.db.prepare('SELECT * FROM reminders WHERE guild_id = ? AND id = ?').get(guildId, id) as ReminderRow | undefined;
    return row ? toReminder(row) : undefined;
  }

  async listActive(guildId: string, userId: string): Promise<Reminder[]> {
    const rows = this.db
      .prepare(`SELECT * FROM reminders WHERE guild_id = ? AND user_id = ? AND status = 'active' ORDER BY due_at ASC, id ASC`)
      .all(guildId, userId) as unknown as ReminderRow[];
    return rows.map(toReminder);
  }

  async countActive(guildId: string, userId: string): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM reminders WHERE guild_id = ? AND user_id = ? AND status = 'active'`)
      .get(guildId, userId) as { count: number };
    return row.count;
  }

  async nextDue(): Promise<Reminder | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM reminders WHERE status = 'active' ORDER BY due_at ASC, id ASC LIMIT 1`)
      .get() as ReminderRow | undefined;
    return row ? toReminder(row) : undefined;
  }

  async listDue(now: number, limit: number): Promise<Reminder[]> {
    const rows = this.db
      .prepare(`SELECT * FROM reminders WHERE status = 'active' AND due_at <= ? ORDER BY due_at ASC, id ASC LIMIT ?`)
      .all(now, limit) as unknown as ReminderRow[];
    return rows.map(toReminder);
  }

  async markFired(id: number, firedAt: number, nextDueAt: number | null): Promise<void> {
    if (nextDueAt === null) {
      this.db
        .prepare(
          `UPDATE reminders SET status = 'done', fired_count = fired_count + 1, last_fired_at = ?, updated_at = ?
            WHERE id = ? AND status = 'active'`,
        )
        .run(firedAt, firedAt, id);
    } else {
      this.db
        .prepare(
          `UPDATE reminders SET due_at = ?, fired_count = fired_count + 1, last_fired_at = ?, updated_at = ?
            WHERE id = ? AND status = 'active'`,
        )
        .run(nextDueAt, firedAt, firedAt, id);
    }
  }

  async cancel(guildId: string, id: number): Promise<boolean> {
    const result = this.db
      .prepare(`UPDATE reminders SET status = 'cancelled', updated_at = ? WHERE guild_id = ? AND id = ? AND status = 'active'`)
      .run(this.clock(), guildId, id);
    return Number(result.changes) > 0;
  }

  async pruneFinishedBefore(cutoff: number): Promise<number> {
    const result = this.db.prepare(`DELETE FROM reminders WHERE status IN ('done', 'cancelled') AND updated_at < ?`).run(cutoff);
    return Number(result.changes);
  }
}

function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    guildId: row.guild_id,
    userId: row.user_id,
    userName: row.user_name,
    kind: row.kind,
    message: row.message,
    audience: row.audience,
    channelId: row.channel_id,
    dueAt: row.due_at,
    repeat: row.repeat ? (JSON.parse(row.repeat) as RepeatRule) : null,
    timeZone: row.time_zone,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    firedCount: row.fired_count,
    lastFiredAt: row.last_fired_at,
    status: row.status,
  };
}
