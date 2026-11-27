import type { RepeatRule, RepeatUnit } from '../storage/ports.js';
import { daysInMonth, zonedParts, zonedToEpoch, type ZonedDateTime } from '../util/zonedTime.js';

/** Repeating more often than this is refused (it would just be noise). */
export const MIN_REPEAT_MS = 5 * 60_000;

export const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekdayName = (typeof WEEKDAY_NAMES)[number];

const FULL_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const UNIT_MS: Partial<Record<RepeatUnit, number>> = { minute: 60_000, hour: 3_600_000 };
const MAX_STEPS = 50_000;

export interface RepeatInput {
  every: RepeatUnit;
  interval?: number;
  weekdays?: readonly WeekdayName[];
}

export class RepeatError extends Error {
  override readonly name = 'RepeatError';
}

/**
 * Builds the stored rule for a repeat that starts at `firstDueAt`, capturing that occurrence's
 * local time of day and date so later ones keep them.
 */
export function buildRepeatRule(input: RepeatInput, firstDueAt: number, timeZone: string): RepeatRule {
  const interval = input.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1) throw new RepeatError('The repeat interval must be a whole number of at least 1.');
  const weekdays = input.weekdays
    ? [...new Set(input.weekdays.map((day) => WEEKDAY_NAMES.indexOf(day)))].sort((a, b) => a - b)
    : undefined;
  if (weekdays && input.every !== 'week') throw new RepeatError('Weekdays only apply to weekly repeats.');
  if (weekdays && interval !== 1) throw new RepeatError('Repeating on specific weekdays only works every week (interval 1).');
  const fixed = UNIT_MS[input.every];
  if (fixed !== undefined && fixed * interval < MIN_REPEAT_MS) {
    throw new RepeatError(`Reminders can repeat at most every ${MIN_REPEAT_MS / 60_000} minutes.`);
  }

  const rule: RepeatRule = { every: input.every, interval };
  if (fixed === undefined) {
    const local = zonedParts(firstDueAt, timeZone);
    rule.localTime = `${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)}`;
    if (input.every === 'month' || input.every === 'year') rule.dayOfMonth = local.day;
    if (input.every === 'year') rule.month = local.month;
  }
  if (weekdays) rule.weekdays = weekdays;
  return rule;
}

/**
 * The first occurrence at or after `at`. For weekly repeats on given weekdays that's the first of
 * those days at `at`'s local time of day; otherwise `at` itself.
 */
export function alignFirstOccurrence(at: number, rule: RepeatRule | null, timeZone: string): number {
  if (!rule?.weekdays?.length) return at;
  const local = zonedParts(at, timeZone);
  for (let offset = 0; offset < 7; offset++) {
    if (rule.weekdays.includes((local.weekday + offset) % 7)) {
      return zonedToEpoch({ ...withoutWeekday(local), day: local.day + offset }, timeZone);
    }
  }
  return at;
}

/**
 * The next time a repeating reminder is due after it was due at `previousDueAt`: the first
 * occurrence strictly later than both `previousDueAt` and `notBefore` (so occurrences missed while
 * the bot was offline are skipped, not delivered in a burst).
 */
export function nextOccurrence(rule: RepeatRule, previousDueAt: number, timeZone: string, notBefore: number): number {
  const floor = Math.max(previousDueAt, notBefore);
  const fixed = UNIT_MS[rule.every];
  if (fixed !== undefined) {
    const step = fixed * rule.interval;
    const steps = Math.max(1, Math.floor((floor - previousDueAt) / step) + 1);
    return previousDueAt + steps * step;
  }

  const [hour, minute, second] = (rule.localTime ?? '00:00:00').split(':').map(Number) as [number, number, number];
  const start = zonedParts(previousDueAt, timeZone);
  const at = (date: { year: number; month: number; day: number }): number =>
    zonedToEpoch({ ...date, hour, minute, second }, timeZone);

  if (rule.every === 'week' && rule.weekdays?.length) {
    for (let offset = 1; offset <= MAX_STEPS; offset++) {
      const date = civilDate(start.year, start.month, start.day + offset);
      if (!rule.weekdays.includes(weekdayOf(date))) continue;
      const candidate = at(date);
      if (candidate > floor) return candidate;
    }
    throw new RepeatError('Could not find the next occurrence.');
  }

  for (let step = 1; step <= MAX_STEPS; step++) {
    const n = step * rule.interval;
    let date: { year: number; month: number; day: number };
    switch (rule.every) {
      case 'day':
        date = civilDate(start.year, start.month, start.day + n);
        break;
      case 'week':
        date = civilDate(start.year, start.month, start.day + 7 * n);
        break;
      case 'month': {
        const monthIndex = start.month - 1 + n;
        const year = start.year + Math.floor(monthIndex / 12);
        const month = (monthIndex % 12) + 1;
        date = { year, month, day: Math.min(rule.dayOfMonth ?? start.day, daysInMonth(year, month)) };
        break;
      }
      case 'year': {
        const year = start.year + n;
        const month = rule.month ?? start.month;
        date = { year, month, day: Math.min(rule.dayOfMonth ?? start.day, daysInMonth(year, month)) };
        break;
      }
      default:
        throw new RepeatError(`Unknown repeat unit "${rule.every}".`);
    }
    const candidate = at(date);
    if (candidate > floor) return candidate;
  }
  throw new RepeatError('Could not find the next occurrence.');
}

/** "every day", "every 2 weeks", "every weekday", "every Monday and Friday". */
export function describeRepeat(rule: RepeatRule): string {
  if (rule.weekdays?.length) {
    const days = rule.weekdays;
    if (days.length === 7) return 'every day';
    if (days.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day))) return 'every weekday';
    if (days.length === 2 && days.includes(0) && days.includes(6)) return 'every weekend day';
    return `every ${joinWords(days.map((day) => FULL_WEEKDAYS[day]!))}`;
  }
  return rule.interval === 1 ? `every ${rule.every}` : `every ${rule.interval} ${rule.every}s`;
}

function civilDate(year: number, month: number, day: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekdayOf(date: { year: number; month: number; day: number }): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function withoutWeekday(parts: ZonedDateTime & { weekday?: number }): ZonedDateTime {
  const { weekday: _weekday, ...rest } = parts;
  return rest;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
