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
