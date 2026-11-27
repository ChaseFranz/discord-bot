import type { Reminder } from '../storage/ports.js';

/**
 * Arranges for a reminder to be delivered when it's due. Running on a PC that's the in-process
 * scheduler (it just re-checks what's due next); on AWS, a wake-up for the reminder Lambda.
 */
export interface ReminderAlarm {
  /** After a reminder is created or moved to its next time. */
  set(reminder: Reminder): Promise<void>;
  /** After a reminder is cancelled. */
  clear(reminderId: number): Promise<void>;
}

/** The in-process scheduler as an alarm: any change just makes it look again. */
export function schedulerAlarm(scheduler: { changed(): void } | undefined | (() => { changed(): void } | undefined)): ReminderAlarm {
  const resolve = () => (typeof scheduler === 'function' ? scheduler() : scheduler);
  return {
    async set() {
      resolve()?.changed();
    },
    async clear() {
      resolve()?.changed();
    },
  };
}
