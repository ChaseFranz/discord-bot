/**
 * Runs `callback` once after `delayMs` and returns a function that cancels it. Injectable so
 * timer-driven features (auto-leave, reminders) can be tested without waiting.
 */
export type Schedule = (callback: () => void, delayMs: number) => () => void;

/** Node's largest setTimeout delay; longer waits are re-armed in steps. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** setTimeout-backed schedule. Timers don't keep the process alive. */
export const systemSchedule: Schedule = (callback, delayMs) => {
  let handle: NodeJS.Timeout | undefined;
  let remaining = Math.max(0, delayMs);
  const arm = () => {
    const step = Math.min(remaining, MAX_TIMEOUT_MS);
    remaining -= step;
    handle = setTimeout(() => (remaining > 0 ? arm() : callback()), step);
    handle.unref();
  };
  arm();
  return () => {
    if (handle) clearTimeout(handle);
  };
};
