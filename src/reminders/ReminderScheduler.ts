import type { Logger } from '../logging/logger.js';
import { describeError } from '../logging/logger.js';
import type { Reminder, ReminderRepository } from '../storage/ports.js';
import type { Schedule } from '../util/schedule.js';
import type { Clock } from '../util/time.js';
import { nextOccurrence } from './recurrence.js';

export interface ReminderDeliveryInfo {
  now: number;
  /** Delivered well after it was due (the bot was offline or asleep). */
  late: boolean;
  /** When a repeating reminder is due next; null for one-offs. */
  nextDueAt: number | null;
}

export type DeliverReminder = (reminder: Reminder, info: ReminderDeliveryInfo) => Promise<void>;

export interface ReminderSchedulerDeps {
  reminders: ReminderRepository;
  deliver: DeliverReminder;
  clock: Clock;
  schedule: Schedule;
  logger: Logger;
}

/** A reminder delivered more than this after it was due counts as late. */
export const LATE_AFTER_MS = 2 * 60_000;
/**
 * Longest wait between checks. Timers don't run while a computer sleeps, so the scheduler also
 * re-checks the wall clock at least this often.
 */
const MAX_WAIT_MS = 60_000;
const BATCH = 20;

/**
 * Delivers reminders when they're due. Reminders live in the repository, so they survive restarts:
 * anything that came due while the bot was off is delivered (marked late) when it starts again,
 * and a repeating reminder then moves on to its next future occurrence.
 */
export class ReminderScheduler {
  private cancelTimer: (() => void) | undefined;
  private running = false;
  private again = false;
  private stopped = true;

  constructor(private readonly deps: ReminderSchedulerDeps) {}

  start(): void {
    this.stopped = false;
    this.poke();
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  /** Call after reminders are added or cancelled, so the next one is timed correctly. */
  changed(): void {
    this.poke();
  }

  /** Resolves once the current check (if any) has finished. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.running) await new Promise((resolve) => setImmediate(resolve));
  }

  private poke(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    void this.run();
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      do {
        this.again = false;
        await this.deliverDue();
        await this.arm();
      } while (this.again && !this.stopped);
    } catch (error) {
      this.deps.logger.error(`Reminder check failed: ${describeError(error)}`);
      if (!this.stopped) this.cancelTimer = this.deps.schedule(() => this.poke(), MAX_WAIT_MS);
    } finally {
      this.running = false;
    }
  }

  private async deliverDue(): Promise<void> {
    const seen = new Set<number>();
    while (!this.stopped) {
      const now = this.deps.clock();
      const due = (await this.deps.reminders.listDue(now, BATCH)).filter((reminder) => !seen.has(reminder.id));
      if (due.length === 0) return;
      for (const reminder of due) {
        if (this.stopped) return;
        seen.add(reminder.id);
        const nextDueAt = this.nextDueAt(reminder, now);
        const late = now - reminder.dueAt > LATE_AFTER_MS;
        // Deliver, then record it: a crash in between repeats a reminder rather than losing it.
        try {
          await this.deps.deliver(reminder, { now, late, nextDueAt });
        } catch (error) {
          this.deps.logger.error(`Could not deliver reminder #${reminder.id}: ${describeError(error)}`);
        }
        await this.deps.reminders.markFired(reminder.id, now, nextDueAt);
      }
    }
  }

  private nextDueAt(reminder: Reminder, now: number): number | null {
    if (!reminder.repeat) return null;
    try {
      return nextOccurrence(reminder.repeat, reminder.dueAt, reminder.timeZone, now);
    } catch (error) {
      this.deps.logger.warn(`Reminder #${reminder.id} can't repeat any more: ${describeError(error)}`);
      return null;
    }
  }

  private async arm(): Promise<void> {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (this.stopped) return;
    const next = await this.deps.reminders.nextDue();
    const wait = next ? Math.min(Math.max(0, next.dueAt - this.deps.clock()), MAX_WAIT_MS) : MAX_WAIT_MS;
    this.cancelTimer = this.deps.schedule(() => this.poke(), wait);
  }
}
