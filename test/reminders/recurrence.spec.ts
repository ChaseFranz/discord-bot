import { alignFirstOccurrence, buildRepeatRule, describeRepeat, nextOccurrence } from '../../src/reminders/recurrence.js';
import { zonedParts, zonedToEpoch } from '../../src/util/zonedTime.js';

const NY = 'America/New_York';
const local = (year: number, month: number, day: number, hour = 0, minute = 0) =>
  zonedToEpoch({ year, month, day, hour, minute, second: 0 }, NY);

describe('repeating reminders', () => {
  it('repeats fixed intervals, skipping ones missed while offline', () => {
    const rule = buildRepeatRule({ every: 'minute', interval: 30 }, 0, NY);
    expect(nextOccurrence(rule, 0, NY, 0)).toBe(30 * 60_000);
    // Offline for 2 hours 10 minutes: the next one is the first still in the future.
    expect(nextOccurrence(rule, 0, NY, 130 * 60_000)).toBe(150 * 60_000);
    expect(nextOccurrence(rule, 0, NY, 120 * 60_000)).toBe(150 * 60_000);
  });

  it('refuses to repeat more often than every five minutes, and odd weekday combinations', () => {
    expect(() => buildRepeatRule({ every: 'minute', interval: 2 }, 0, NY)).toThrow('every 5 minutes');
    expect(() => buildRepeatRule({ every: 'day', weekdays: ['mon'] }, 0, NY)).toThrow('weekly');
    expect(() => buildRepeatRule({ every: 'week', interval: 2, weekdays: ['mon'] }, 0, NY)).toThrow('interval 1');
  });

  it('keeps the local time of day across daylight saving changes', () => {
    const first = local(2026, 3, 7, 9); // Saturday before the spring change
    const rule = buildRepeatRule({ every: 'day' }, first, NY);
    expect(rule).toEqual({ every: 'day', interval: 1, localTime: '09:00:00' });
    const next = nextOccurrence(rule, first, NY, first);
    expect(next - first).toBe(23 * 60 * 60_000); // the clocks jumped forward an hour
    expect(zonedParts(next, NY)).toMatchObject({ day: 8, hour: 9, minute: 0 });
  });

  it('repeats weekly, on chosen weekdays, monthly and yearly', () => {
    const friday = local(2026, 11, 27, 20); // Friday 8 PM
    const weekly = buildRepeatRule({ every: 'week' }, friday, NY);
    expect(nextOccurrence(weekly, friday, NY, friday)).toBe(local(2026, 12, 4, 20));

    const weekdays = buildRepeatRule({ every: 'week', weekdays: ['mon', 'wed', 'fri'] }, friday, NY);
    expect(weekdays.weekdays).toEqual([1, 3, 5]);
    expect(nextOccurrence(weekdays, friday, NY, friday)).toBe(local(2026, 11, 30, 20)); // Monday
    expect(describeRepeat(weekdays)).toBe('every Monday, Wednesday and Friday');

    const jan31 = local(2027, 1, 31, 10);
    const monthly = buildRepeatRule({ every: 'month' }, jan31, NY);
    const feb = nextOccurrence(monthly, jan31, NY, jan31);
    expect(feb).toBe(local(2027, 2, 28, 10)); // a short month: its last day
    expect(nextOccurrence(monthly, feb, NY, feb)).toBe(local(2027, 3, 31, 10)); // back to the 31st

    const leapDay = local(2028, 2, 29, 12);
    const yearly = buildRepeatRule({ every: 'year' }, leapDay, NY);
    expect(nextOccurrence(yearly, leapDay, NY, leapDay)).toBe(local(2029, 2, 28, 12));
  });

  it('starts weekday repeats on the first matching day', () => {
    const saturday = local(2026, 11, 28, 9);
    const rule = buildRepeatRule({ every: 'week', weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'] }, saturday, NY);
    expect(alignFirstOccurrence(saturday, rule, NY)).toBe(local(2026, 11, 30, 9));
    expect(describeRepeat(rule)).toBe('every weekday');
    expect(alignFirstOccurrence(saturday, null, NY)).toBe(saturday);
  });

  it('describes repeats', () => {
    expect(describeRepeat({ every: 'day', interval: 1 })).toBe('every day');
    expect(describeRepeat({ every: 'week', interval: 2 })).toBe('every 2 weeks');
    expect(describeRepeat({ every: 'week', interval: 1, weekdays: [0, 6] })).toBe('every weekend day');
  });
});
