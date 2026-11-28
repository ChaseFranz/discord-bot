import { DynamoVoiceTaskStore } from '../../src/aws/adapters.js';
import { HEARTBEAT_STALE_MS, MemoryVoiceTaskStore, START_TIMEOUT_MS, isLive, type VoiceTaskStore } from '../../src/calls/voiceTask.js';
import { handleReminderWakeUp, type ReminderWakeUp } from '../../src/reminders/wakeUp.js';
import type { NewReminder, Reminder } from '../../src/storage/ports.js';
import { createDocumentClient } from '../../src/storage/dynamodb/dynamo.js';
import { openStorage, type Storage } from '../../src/storage/open.js';
import { fakeClock, silentLogger } from '../helpers.js';
import { backends, dynamoEndpoint, type TestStorage } from '../storage/backends.js';

const stores: Array<{ name: string; open(): Promise<{ store: VoiceTaskStore; close(): Promise<void> }> }> = [
  { name: 'memory', open: async () => ({ store: new MemoryVoiceTaskStore(), close: async () => undefined }) },
];
if (dynamoEndpoint) {
  stores.push({
    name: 'dynamodb',
    open: async () => {
      const storage: TestStorage = await backends.find((backend) => backend.name === 'dynamodb')!.open(fakeClock());
      const doc = createDocumentClient({ region: 'us-east-1', endpoint: dynamoEndpoint });
      return {
        store: new DynamoVoiceTaskStore(doc, storage.tables!.main),
        close: async () => {
          doc.destroy();
          await storage.close();
        },
      };
    },
  });
}

describe.each(stores)('voice task status record ($name)', ({ open }) => {
  let store: VoiceTaskStore;
  let close: () => Promise<void>;
  beforeEach(async () => ({ store, close } = await open()));
  afterEach(() => close());

  it('lets exactly one of two simultaneous /joins start a task', async () => {
    const now = 1_000_000;
    const claims = await Promise.all([store.claimStart('g', now), store.claimStart('g', now)]);
    expect(claims.sort()).toEqual([false, true]);
    await store.setTaskArn('g', 'arn:task/1');
    expect(await store.get('g')).toMatchObject({ guildId: 'g', status: 'starting', startedAt: now, taskArn: 'arn:task/1' });
  });

  it('records heartbeats with the call, and allows a new start once the task goes quiet', async () => {
    const now = 1_000_000;
    await store.claimStart('g', now);
    const call = { channelId: 'vc', channelName: 'General', people: [{ id: 'u1', name: 'Alice' }], music: 'nothing playing' };
    await store.heartbeat('g', now + 5_000, call);
    expect(await store.get('g')).toMatchObject({ status: 'running', heartbeatAt: now + 5_000, startedAt: now, call });
    await store.heartbeat('g', now + 10_000, undefined);
    expect((await store.get('g'))?.call).toBeUndefined();
    expect(await store.claimStart('g', now + 20_000)).toBe(false);
    expect(await store.claimStart('g', now + 10_000 + HEARTBEAT_STALE_MS + 1)).toBe(true);
    await store.clear('g');
    expect(await store.get('g')).toBeUndefined();
    await store.setTaskArn('g', 'ignored when there is no record');
    expect(await store.get('g')).toBeUndefined();
  });
});

// What the endpoint music helpers talk to reads of the record, to tell them how often to ask for work.
(dynamoEndpoint ? describe : describe.skip)('whether a voice task is live, as music helpers are told (dynamodb)', () => {
  it('reads only the fields that say so, never the call or who is in it', async () => {
    const storage: TestStorage = await backends.find((backend) => backend.name === 'dynamodb')!.open(fakeClock());
    const doc = createDocumentClient({ region: 'us-east-1', endpoint: dynamoEndpoint });
    const store = new DynamoVoiceTaskStore(doc, storage.tables!.main);
    try {
      const now = 1_000_000;
      expect(await store.liveness('g')).toBeUndefined();
      expect(isLive(await store.liveness('g'), now)).toBe(false);

      // Someone asked for a call: on its way.
      await store.claimStart('g', now);
      await store.setTaskArn('g', 'arn:task/1');
      expect(await store.liveness('g')).toEqual({ status: 'starting', startedAt: now, heartbeatAt: now });
      expect(isLive(await store.liveness('g'), now + START_TIMEOUT_MS - 1)).toBe(true);

      // In the call.
      const call = { channelId: 'vc', channelName: 'General', people: [{ id: 'u1', name: 'Alice' }], music: 'playing "Song"' };
      await store.heartbeat('g', now + 30_000, call);
      const live = await store.liveness('g');
      expect(live).toEqual({ status: 'running', startedAt: now, heartbeatAt: now + 30_000 });
      expect(isLive(live, now + 31_000)).toBe(true);
      // A task that stopped reporting in is not live, even before its record is cleared.
      expect(isLive(live, now + 30_000 + HEARTBEAT_STALE_MS)).toBe(false);

      await store.clear('g');
      expect(await store.liveness('g')).toBeUndefined();
    } finally {
      doc.destroy();
      await storage.close();
    }
  });
});

describe('reminder wake-ups', () => {
  let storage: Storage;
  const clock = fakeClock(Date.UTC(2026, 10, 26, 19, 0, 0));
  const delivered: Array<{ id: number; late: boolean; nextDueAt: number | null }> = [];
  const armed: Reminder[] = [];
  const slept: number[] = [];

  const deps = () => ({
    reminders: storage.reminders,
    alarm: { set: async (reminder: Reminder) => void armed.push(reminder), clear: async () => undefined },
    deliver: async (reminder: Reminder, info: { late: boolean; nextDueAt: number | null }) =>
      void delivered.push({ id: reminder.id, late: info.late, nextDueAt: info.nextDueAt }),
    clock,
    sleep: async (ms: number) => {
      slept.push(ms);
      clock.advance(ms);
    },
    logger: silentLogger(),
    maxWaitMs: 14 * 60_000,
  });
  const newReminder = (overrides: Partial<NewReminder> = {}): NewReminder => ({
    guildId: 'g', userId: 'alice', userName: 'Alice', kind: 'timer', message: '', audience: 'me', channelId: 'c',
    dueAt: clock() + 30_000, repeat: null, timeZone: 'UTC', durationMs: 30_000, createdAt: clock(), ...overrides,
  });
  const wakeUpFor = (reminder: Reminder): ReminderWakeUp => ({ reminderId: reminder.id, guildId: reminder.guildId, dueAt: reminder.dueAt });

  beforeEach(() => {
    clock.set(Date.UTC(2026, 10, 26, 19, 0, 0));
    storage = openStorage({ kind: 'sqlite', databasePath: ':memory:', memoryDatabasePath: ':memory:' }, { retentionDays: 30, clock });
    delivered.length = 0;
    armed.length = 0;
    slept.length = 0;
  });
  afterEach(() => storage.close());

  it('waits for the exact moment, then delivers once', async () => {
    const timer = await storage.reminders.create(newReminder());
    expect(await handleReminderWakeUp(wakeUpFor(timer), deps())).toBe('delivered');
    expect(slept).toEqual([30_000]);
    expect(delivered).toEqual([{ id: timer.id, late: false, nextDueAt: null }]);
    expect((await storage.reminders.get('g', timer.id))?.status).toBe('done');
    // A duplicate wake-up for the same time does nothing.
    expect(await handleReminderWakeUp(wakeUpFor(timer), deps())).toBe('skipped');
    expect(delivered).toHaveLength(1);
  });

  it('does nothing for a cancelled or moved reminder', async () => {
    const cancelled = await storage.reminders.create(newReminder());
    await storage.reminders.cancel('g', cancelled.id);
    expect(await handleReminderWakeUp(wakeUpFor(cancelled), deps())).toBe('skipped');
    const moved = await storage.reminders.create(newReminder());
    expect(await handleReminderWakeUp({ ...wakeUpFor(moved), dueAt: moved.dueAt - 60_000 }, deps())).toBe('skipped');
    expect(delivered).toEqual([]);
  });

  it('moves a repeating reminder on and arranges the next wake-up', async () => {
    const daily = await storage.reminders.create(
      newReminder({ kind: 'reminder', message: 'stretch', durationMs: null, repeat: { every: 'day', interval: 1, localTime: '19:00:30' } }),
    );
    await handleReminderWakeUp(wakeUpFor(daily), deps());
    const next = daily.dueAt + 24 * 60 * 60_000;
    expect(delivered).toEqual([{ id: daily.id, late: false, nextDueAt: next }]);
    expect(armed.map((reminder) => reminder.dueAt)).toEqual([next]);
    expect((await storage.reminders.get('g', daily.id))?.dueAt).toBe(next);
  });

  it('asks to be woken again when woken far too early', async () => {
    const later = await storage.reminders.create(newReminder({ dueAt: clock() + 60 * 60_000 }));
    expect(await handleReminderWakeUp(wakeUpFor(later), deps())).toBe('rescheduled');
    expect(armed.map((reminder) => reminder.id)).toEqual([later.id]);
    expect(slept).toEqual([]);
  });
});
