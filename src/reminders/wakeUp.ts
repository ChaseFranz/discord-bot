import type { Logger } from '../logging/logger.js';
import { describeError } from '../logging/logger.js';
import type { ReminderRepository } from '../storage/ports.js';
import type { Clock } from '../util/time.js';
import type { ReminderAlarm } from './alarm.js';
import { nextOccurrence } from './recurrence.js';
import { LATE_AFTER_MS, type DeliverReminder } from './ReminderScheduler.js';

export interface ReminderWakeUp {
  reminderId: number;
  guildId: string;
  /** The due time this wake-up is for; if the reminder has since moved or been cancelled, it does nothing. */
  dueAt: number;
}

export interface WakeUpDeps {
  reminders: ReminderRepository;
  alarm: ReminderAlarm;
  deliver: DeliverReminder;
  clock: Clock;
  sleep(ms: number): Promise<void>;
  logger: Logger;
  /** Longest it may wait for the due time (the Lambda's own time limit leaves room for the rest). */
  maxWaitMs: number;
}

/**
 * Handles one wake-up of the reminder Lambda: waits until the reminder's exact due time, delivers
 * it if it's still on, records the delivery, and arranges the next wake-up for a repeating one.
 */
export async function handleReminderWakeUp(wakeUp: ReminderWakeUp, deps: WakeUpDeps): Promise<'delivered' | 'skipped' | 'rescheduled'> {
  const early = wakeUp.dueAt - deps.clock();
  if (early > deps.maxWaitMs) {
    // Woken too early to wait it out: ask to be woken again closer to the time.
    const reminder = await deps.reminders.get(wakeUp.guildId, wakeUp.reminderId);
    if (reminder?.status !== 'active' || reminder.dueAt !== wakeUp.dueAt) return 'skipped';
    await deps.alarm.set(reminder);
    return 'rescheduled';
  }
  if (early > 0) await deps.sleep(early);

  const reminder = await deps.reminders.get(wakeUp.guildId, wakeUp.reminderId);
  // Cancelled, already delivered, or moved to another time since this wake-up was arranged.
  if (!reminder || reminder.status !== 'active' || reminder.dueAt !== wakeUp.dueAt) return 'skipped';

  const now = deps.clock();
  let nextDueAt: number | null = null;
  if (reminder.repeat) {
    try {
      nextDueAt = nextOccurrence(reminder.repeat, reminder.dueAt, reminder.timeZone, now);
    } catch (error) {
      deps.logger.warn(`Reminder #${reminder.id} can't repeat any more: ${describeError(error)}`);
    }
  }
  // Deliver, then record it: a crash in between repeats a reminder rather than losing it.
  try {
    await deps.deliver(reminder, { now, late: now - reminder.dueAt > LATE_AFTER_MS, nextDueAt });
  } catch (error) {
    deps.logger.error(`Could not deliver reminder #${reminder.id}: ${describeError(error)}`);
  }
  await deps.reminders.markFired(reminder.id, now, nextDueAt);
  if (nextDueAt !== null) await deps.alarm.set({ ...reminder, dueAt: nextDueAt });
  return 'delivered';
}
