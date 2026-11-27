import {
  describeDuration,
  localDayKey,
  parseLocalOrAbsolute,
  shiftDayKey,
  startOfNextLocalDay,
  zonedParts,
  zonedToEpoch,
} from '../../src/util/zonedTime.js';

const NY = 'America/New_York';

describe('zoned time', () => {
  it('reads local parts of an instant', () => {
    // 2026-11-26 19:30 UTC is 14:30 in New York (EST, UTC-5), a Thursday.
    expect(zonedParts(Date.UTC(2026, 10, 26, 19, 30, 15), NY)).toEqual({
      year: 2026, month: 11, day: 26, hour: 14, minute: 30, second: 15, weekday: 4,
    });
    expect(zonedParts(Date.UTC(2026, 10, 26, 0, 0, 0), 'UTC').hour).toBe(0);
  });

  it('converts wall-clock times to instants in either half of the year', () => {
    expect(zonedToEpoch({ year: 2026, month: 11, day: 27, hour: 21, minute: 0, second: 0 }, NY)).toBe(Date.UTC(2026, 10, 28, 2, 0, 0));
    expect(zonedToEpoch({ year: 2026, month: 7, day: 4, hour: 21, minute: 0, second: 0 }, NY)).toBe(Date.UTC(2026, 6, 5, 1, 0, 0));
    expect(zonedToEpoch({ year: 2026, month: 3, day: 1, hour: 9, minute: 0, second: 0 }, 'Asia/Kathmandu')).toBe(Date.UTC(2026, 2, 1, 3, 15, 0));
  });

  it('moves a time skipped by the spring-forward change past the gap', () => {
    // 8 March 2026, 02:30 doesn't exist in New York (clocks go 02:00 -> 03:00 EDT).
    const t = zonedToEpoch({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, NY);
    expect(zonedParts(t, NY)).toMatchObject({ hour: 3, minute: 30 });
  });

  it('resolves a time that happens twice in the fall-back hour to one of them', () => {
    const t = zonedToEpoch({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, NY);
    expect(zonedParts(t, NY)).toMatchObject({ day: 1, hour: 1, minute: 30 });
  });

  it('knows local days and midnights', () => {
    const lateEvening = Date.UTC(2026, 10, 27, 4, 30); // 23:30 on the 26th in New York
    expect(localDayKey(lateEvening, NY)).toBe('2026-11-26');
    expect(localDayKey(lateEvening, 'UTC')).toBe('2026-11-27');
    expect(startOfNextLocalDay(lateEvening, NY)).toBe(Date.UTC(2026, 10, 27, 5, 0));
    expect(shiftDayKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDayKey('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('parses local and absolute times the model writes, rejecting anything else', () => {
    expect(parseLocalOrAbsolute('2026-11-27T21:00', NY)).toBe(Date.UTC(2026, 10, 28, 2, 0));
    expect(parseLocalOrAbsolute('2026-11-27 21:00:30', NY)).toBe(Date.UTC(2026, 10, 28, 2, 0, 30));
    expect(parseLocalOrAbsolute('2026-11-27T21:00:00Z', NY)).toBe(Date.UTC(2026, 10, 27, 21, 0));
    expect(parseLocalOrAbsolute('2026-11-27T21:00-08:00', NY)).toBe(Date.UTC(2026, 10, 28, 5, 0));
    expect(parseLocalOrAbsolute('2026-02-30T09:00', NY)).toBeUndefined();
    expect(parseLocalOrAbsolute('tomorrow at 9', NY)).toBeUndefined();
    expect(parseLocalOrAbsolute('2026-11-27', NY)).toBeUndefined();
  });

  it('describes durations the way you would say them', () => {
    expect(describeDuration(45_000)).toBe('45 seconds');
    expect(describeDuration(60_000)).toBe('1 minute');
    expect(describeDuration(90 * 60_000)).toBe('1 hour 30 minutes');
    expect(describeDuration(24 * 60 * 60_000)).toBe('1 day');
    expect(describeDuration((2 * 24 + 3) * 60 * 60_000 + 5 * 60_000)).toBe('2 days 3 hours');
  });
});
