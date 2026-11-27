/**
 * Wall-clock arithmetic in an IANA time zone, using only Intl (no dependencies). Reminders and the
 * daily budget work in the server's local time ("every day at 9", "until midnight"), so they need
 * to convert between epoch milliseconds and local dates and times, including across DST changes.
 */

export interface ZonedDateTime {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
  /** 0-23 */
  hour: number;
  minute: number;
  second: number;
}

export interface ZonedParts extends ZonedDateTime {
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The local date, time and weekday of an instant in `timeZone`. */
export function zonedParts(epochMs: number, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(epochMs))) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? ''] ?? 0,
  };
}

/** The zone's offset from UTC at an instant, in milliseconds (positive east of Greenwich). */
function offsetAt(epochMs: number, timeZone: string): number {
  const p = zonedParts(epochMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * The instant at which the clocks in `timeZone` show `local`. Out-of-range fields roll over the
 * way Date.UTC does (day 32 is the 1st of the next month). A time skipped by a DST change (2:30 on
 * the night clocks jump from 2:00 to 3:00) moves forward by the size of the jump; a time that
 * happens twice resolves to one of the two.
 */
export function zonedToEpoch(local: ZonedDateTime, timeZone: string): number {
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  const firstGuess = wall - offsetAt(wall, timeZone);
  const firstOffset = offsetAt(firstGuess, timeZone);
  if (firstGuess + firstOffset === wall) return firstGuess;
  const secondGuess = wall - firstOffset;
  if (secondGuess + offsetAt(secondGuess, timeZone) === wall) return secondGuess;
  // The wall time doesn't exist (DST gap): use the later candidate, i.e. after the jump.
  return Math.max(firstGuess, secondGuess);
}

/** The local calendar day of an instant, as `YYYY-MM-DD`. */
export function localDayKey(epochMs: number, timeZone: string): string {
  const p = zonedParts(epochMs, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The local day `days` before or after the day of `dayKey` (`YYYY-MM-DD`). */
export function shiftDayKey(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** The instant the next local day starts (local midnight) after `epochMs`. */
export function startOfNextLocalDay(epochMs: number, timeZone: string): number {
  const p = zonedParts(epochMs, timeZone);
  return zonedToEpoch({ year: p.year, month: p.month, day: p.day + 1, hour: 0, minute: 0, second: 0 }, timeZone);
}

/** Days in a month (month 1-12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parses a date/time the model wrote. With an explicit offset or `Z` it is an absolute instant;
 * without one (`2026-11-27T21:00`) it is a wall-clock time in `timeZone`. Returns undefined when
 * the text isn't a date/time in one of those forms.
 */
export function parseLocalOrAbsolute(text: string, timeZone: string): number | undefined {
  const value = text.trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (local) {
    const [, year, month, day, hour, minute, second] = local;
    const fields = {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second ?? 0),
    };
    if (!isValidLocal(fields)) return undefined;
    return zonedToEpoch(fields, timeZone);
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const ms = Date.parse(value.replace(' ', 'T'));
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

function isValidLocal(f: ZonedDateTime): boolean {
  return (
    f.month >= 1 &&
    f.month <= 12 &&
    f.day >= 1 &&
    f.day <= daysInMonth(f.year, f.month) &&
    f.hour >= 0 &&
    f.hour <= 23 &&
    f.minute >= 0 &&
    f.minute <= 59 &&
    f.second >= 0 &&
    f.second <= 59
  );
}

/** "Friday, November 27 at 9:00 PM" in `timeZone` (adds the year when it isn't the current one). */
export function describeLocalTime(epochMs: number, timeZone: string, now: number): string {
  const sameYear = zonedParts(epochMs, timeZone).year === zonedParts(now, timeZone).year;
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' as const }),
  }).format(new Date(epochMs));
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(epochMs));
  return `${date} at ${time}`;
}

/** "9:00 PM" in `timeZone`. */
export function describeClockTime(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(epochMs));
}

/** "2 hours 5 minutes", "45 seconds": a duration the way you'd say it. */
export function describeDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return plural(totalSeconds, 'second');
  const totalMinutes = Math.round(totalSeconds / 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(plural(days, 'day'));
  if (hours > 0) parts.push(plural(hours, 'hour'));
  if (minutes > 0 && days === 0) parts.push(plural(minutes, 'minute'));
  // Exactly one day, e.g. 24h: "1 day".
  return parts.length > 0 ? parts.join(' ') : plural(totalMinutes, 'minute');
}

/** A duration used before a noun: "10 minute", "1 hour 30 minute" (as in "your 10 minute timer"). */
export function describeLength(ms: number): string {
  return describeDuration(ms).replace(/\b(\d+) (second|minute|hour|day)s\b/g, '$1 $2');
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
