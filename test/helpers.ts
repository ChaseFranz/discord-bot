import winston from 'winston';
import type { Logger } from '../src/logging/logger.js';

/** A logger that discards everything (keeps test output clean). */
export function silentLogger(): Logger {
  return winston.createLogger({ silent: true, transports: [new winston.transports.Console({ silent: true })] });
}

/** A controllable clock. */
export function fakeClock(start = Date.UTC(2026, 10, 26, 19, 0, 0)) {
  let now = start;
  const clock = () => now;
  return Object.assign(clock, {
    advance(ms: number) {
      now += ms;
    },
    set(ms: number) {
      now = ms;
    },
  });
}

/**
 * A Schedule driven by a fake clock: `advance(ms)` moves time forward and runs every callback that
 * comes due, in order.
 */
export function fakeSchedule(clock: ReturnType<typeof fakeClock>) {
  let nextId = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const schedule = (callback: () => void, delayMs: number) => {
    const id = nextId++;
    pending.set(id, { at: clock() + Math.max(0, delayMs), callback });
    return () => {
      pending.delete(id);
    };
  };
  return Object.assign(schedule, {
    /** Number of callbacks waiting. */
    count(): number {
      return pending.size;
    },
    /** When the next callback is due, if any. */
    nextAt(): number | undefined {
      return [...pending.values()].reduce<number | undefined>((min, task) => (min === undefined || task.at < min ? task.at : min), undefined);
    },
    advance(ms: number) {
      const end = clock() + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        clock.set(Math.max(clock(), due[1].at));
        due[1].callback();
      }
      clock.set(end);
    },
  });
}

/** Lets pending promise callbacks run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}
