/** Source of the current time; injectable so tests are deterministic. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

/** ISO-8601 UTC timestamp without milliseconds, e.g. `2026-11-26T19:03:12Z`. */
export function isoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Human-friendly local time, e.g. `Thursday, November 26, 2026, 2:03 PM`. */
export function localDateTime(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(epochMs));
}

/** Local wall-clock time of day, e.g. `14:03:12`. */
export function localClockTime(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(epochMs));
}

/**
 * Parses an ISO-8601 date/time string into epoch milliseconds.
 * Returns undefined for undefined input; throws on unparseable input.
 */
export function parseTimestamp(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`${field} must be an ISO-8601 date/time such as 2026-11-26T19:00:00Z (got "${value}")`);
  }
  return ms;
}
