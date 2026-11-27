import type { NewReminder } from '../../src/storage/ports.js';
import type { Storage } from '../../src/storage/open.js';
import { fakeClock } from '../helpers.js';
import { backends } from './backends.js';

const START = Date.UTC(2026, 10, 26, 19, 0, 0);

function newReminder(overrides: Partial<NewReminder> = {}): NewReminder {
  return {
    guildId: 'g', userId: 'alice', userName: 'Alice', kind: 'reminder', message: 'stretch', audience: 'me', channelId: 'chat',
    dueAt: START + 60_000, repeat: null, timeZone: 'America/New_York', durationMs: null, createdAt: START, ...overrides,
  };
}

describe.each(backends)('settings, usage and reminders ($name)', (backend) => {
  let storage: Storage;
  const clock = fakeClock(START);

  beforeEach(async () => {
    clock.set(START);
    storage = await backend.open(clock);
  });
  afterEach(() => storage.close());

  it('keeps style and privacy independently, with defaults', async () => {
    const scope = { guildId: 'g', userId: 'u' };
    expect(await storage.settings.get(scope)).toBeUndefined();
    expect(await storage.settings.update(scope, { privacy: 'off' })).toEqual({ style: 'default', privacy: 'off' });
    expect(await storage.settings.update(scope, { style: 'casual' })).toEqual({ style: 'casual', privacy: 'off' });
    expect(await storage.settings.get(scope)).toEqual({ style: 'casual', privacy: 'off' });
    expect(await storage.settings.get({ guildId: 'g', userId: 'other' })).toBeUndefined();
  });

  it('adds up usage per metric and day, with daily totals', async () => {
    await storage.usage.add('g', '2026-11-25', [{ metric: 'transcribe.seconds', quantity: 12.5, costUsd: 0.0020835 }]);
    await storage.usage.add('g', '2026-11-26', [
      { metric: 'claude.claude-opus-5-5.output_tokens', quantity: 500, costUsd: 0.01 },
      { metric: 'transcribe.seconds', quantity: 1.25, costUsd: 0.00020838 },
    ]);
    await storage.usage.add('g', '2026-11-26', [{ metric: 'transcribe.seconds', quantity: 2.5, costUsd: 0.00041675 }]);
    await storage.usage.add('other', '2026-11-26', [{ metric: 'transcribe.seconds', quantity: 99, costUsd: 1 }]);

    const day = await storage.usage.day('g', '2026-11-26');
    expect(day.map((line) => line.metric)).toEqual(['claude.claude-opus-5-5.output_tokens', 'transcribe.seconds']);
    expect(day[1]!.quantity).toBeCloseTo(3.75, 6);
    expect(day[1]!.costUsd).toBeCloseTo(0.00062513, 9);
    const totals = await storage.usage.dailyTotals('g', '2026-11-20', '2026-11-26');
    expect(totals.map((t) => t.day)).toEqual(['2026-11-25', '2026-11-26']);
    expect(totals[1]!.costUsd).toBeCloseTo(0.01062513, 9);
    expect(await storage.usage.day('g', '2026-11-24')).toEqual([]);
  });

  it('stores, lists, fires and cancels reminders', async () => {
    const reminders = storage.reminders;
    const a = await reminders.create(newReminder({ dueAt: START + 120_000 }));
    const b = await reminders.create(newReminder({ dueAt: START + 60_000, repeat: { every: 'day', interval: 1, localTime: '14:01:00' } }));
    await reminders.create(newReminder({ userId: 'sam', dueAt: START + 30_000 }));
    expect((await reminders.listActive('g', 'alice')).map((r) => r.id)).toEqual([b.id, a.id]);
    expect(await reminders.get('g', b.id)).toMatchObject({ repeat: { every: 'day', interval: 1, localTime: '14:01:00' }, status: 'active', firedCount: 0 });
    expect(await reminders.get('elsewhere', b.id)).toBeUndefined();
    expect((await reminders.nextDue())?.userId).toBe('sam');
    expect((await reminders.listDue(START + 90_000, 10)).map((r) => r.userId)).toEqual(['sam', 'alice']);
    expect(await reminders.countActive('g', 'alice')).toBe(2);

    await reminders.markFired(b.id, START + 60_000, START + 86_460_000);
    expect(await reminders.get('g', b.id)).toMatchObject({ status: 'active', dueAt: START + 86_460_000, firedCount: 1, lastFiredAt: START + 60_000 });
    expect((await reminders.listActive('g', 'alice')).map((r) => r.id)).toEqual([a.id, b.id]); // b moved to tomorrow

    await reminders.markFired(a.id, START + 120_000, null);
    expect(await reminders.get('g', a.id)).toMatchObject({ status: 'done', firedCount: 1 });
    expect(await reminders.cancel('g', a.id)).toBe(false);
    expect(await reminders.cancel('elsewhere', b.id)).toBe(false);
    expect(await reminders.cancel('g', b.id)).toBe(true);
    expect(await reminders.countActive('g', 'alice')).toBe(0);
    expect((await reminders.listDue(Number.MAX_SAFE_INTEGER, 10)).map((r) => r.userId)).toEqual(['sam']);
  });
});
