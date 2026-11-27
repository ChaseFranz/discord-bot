import type { ToolContext } from '../../src/assistant/tools/types.js';
import { createReminderDelivery, spokenReminder, writtenReminder } from '../../src/reminders/ReminderDelivery.js';
import { ReminderScheduler, type ReminderDeliveryInfo } from '../../src/reminders/ReminderScheduler.js';
import { MAX_ACTIVE_REMINDERS, createReminderToolProvider } from '../../src/reminders/reminderTools.js';
import type { NewReminder, Reminder } from '../../src/storage/ports.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/sqlite/database.js';
import { SqliteReminderRepository } from '../../src/storage/sqlite/SqliteReminderRepository.js';
import { zonedToEpoch } from '../../src/util/zonedTime.js';
import { fakeClock, fakeSchedule, settle, silentLogger } from '../helpers.js';

const NY = 'America/New_York';
// Thursday 26 November 2026, 2:00 PM in New York.
const START = Date.UTC(2026, 10, 26, 19, 0, 0);

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    guildId: 'g',
    userId: 'alice',
    userDisplayName: 'Alice',
    modality: 'voice',
    voiceChannelId: 'vc',
    textChannelId: 'vc',
    signals: { silenceRequested: false, stopRequested: false },
    ...overrides,
  };
}

function newReminder(overrides: Partial<NewReminder> = {}): NewReminder {
  return {
    guildId: 'g', userId: 'alice', userName: 'Alice', kind: 'reminder', message: 'stretch', audience: 'me', channelId: 'chat',
    dueAt: START + 60_000, repeat: null, timeZone: NY, durationMs: null, createdAt: START, ...overrides,
  };
}

describe('reminders', () => {
  let db: SqliteDatabase;
  let repo: SqliteReminderRepository;
  let clock: ReturnType<typeof fakeClock>;

  beforeEach(() => {
    db = openDatabase(':memory:');
    clock = fakeClock(START);
    repo = new SqliteReminderRepository(db, clock);
  });
  afterEach(() => db.close());

  describe('tools', () => {
    let changes: number;
    let tools: ReturnType<typeof createReminderToolProvider>;
    beforeEach(() => {
      changes = 0;
      tools = createReminderToolProvider({
        reminders: repo,
        alarm: { set: async () => void changes++, clear: async () => void changes++ },
        clock,
        timeZone: NY,
      });
    });
    const call = (name: string, input: unknown, ctx = context()) => tools.callTool(name, input, ctx);

    it('sets a timer from a delay', async () => {
      const result = await call('set_reminder', { kind: 'timer', in_seconds: 600, message: 'pizza' });
      expect(result.isError).toBeFalsy();
      expect(result.content).toBe('Set a 10 minute timer for pizza (#1). It goes off Thursday, November 26 at 2:10 PM (in 10 minutes).');
      expect(await repo.get('g', 1)).toMatchObject({ kind: 'timer', durationMs: 600_000, dueAt: START + 600_000, channelId: 'vc', audience: 'me' });
      expect(changes).toBe(1);
    });

    it('sets a reminder at a local time, repeating, for everyone', async () => {
      const result = await call('set_reminder', {
        message: 'start the raid', at: '2026-11-27T21:00', repeat: { every: 'week' }, for_everyone: true,
      });
      expect(result.content).toBe(
        'Set reminder #1, "start the raid", for Friday, November 27 at 9:00 PM (in 1 day 7 hours), repeating every week, for everyone in the call.',
      );
      expect(await repo.get('g', 1)).toMatchObject({
        audience: 'everyone', dueAt: zonedToEpoch({ year: 2026, month: 11, day: 27, hour: 21, minute: 0, second: 0 }, NY),
        repeat: { every: 'week', interval: 1, localTime: '21:00:00' },
      });
    });

    it('starts a daily repeat tomorrow when today\'s time has passed', async () => {
      const result = await call('set_reminder', { message: 'take vitamins', at: '2026-11-26T09:00', repeat: { every: 'day' } });
      expect(result.content).toContain('for Friday, November 27 at 9:00 AM');
    });

    it('rejects bad requests with explanations', async () => {
      expect((await call('set_reminder', { message: 'x', at: '2026-11-26T09:00' })).content).toContain('already passed');
      expect((await call('set_reminder', { message: 'x' })).content).toBe('Give exactly one of "at" or "in_seconds".');
      expect((await call('set_reminder', { message: 'x', at: 'tomorrow' })).content).toContain('must look like');
      expect((await call('set_reminder', { kind: 'timer', in_seconds: 60, repeat: { every: 'day' } })).content).toContain('Timers do not repeat');
      expect((await call('set_reminder', { in_seconds: 60 })).content).toContain('Say what the reminder is for');
      expect((await call('set_reminder', { message: 'x', in_seconds: 60 }, context({ textChannelId: undefined }))).isError).toBe(true);
      expect((await call('set_reminder', { message: 'x', in_seconds: 1 })).isError).toBe(true); // under the minimum
      for (let i = 0; i < MAX_ACTIVE_REMINDERS; i++) await repo.create(newReminder());
      expect((await call('set_reminder', { message: 'one more', in_seconds: 60 })).content).toContain('already has 25');
    });

    it("lists and cancels only the caller's reminders", async () => {
      await call('set_reminder', { message: 'stretch', in_seconds: 3_600 });
      await call('set_reminder', { message: 'feed the cat', in_seconds: 1_800 }, context({ userId: 'sam', userDisplayName: 'Sam' }));
      const list = await call('list_reminders', {});
      expect(list.content).toBe('- #1 Thursday, November 26 at 3:00 PM (in 1 hour): stretch');
      expect((await call('cancel_reminder', { reminder_id: 2 })).content).toBe('Reminder #2 was set by Sam; only they can cancel it.');
      expect((await call('cancel_reminder', { reminder_id: 1 })).content).toBe('Cancelled #1 Thursday, November 26 at 3:00 PM (in 1 hour): stretch');
      expect((await call('list_reminders', {})).content).toBe('Alice has no reminders or timers set.');
      expect((await call('cancel_reminder', { reminder_id: 1 })).isError).toBe(true);
    });
  });

  describe('scheduler', () => {
    it('delivers on time, flags late ones, and moves repeats on', async () => {
      const schedule = fakeSchedule(clock);
      const delivered: Array<{ id: number; info: ReminderDeliveryInfo }> = [];
      const scheduler = new ReminderScheduler({
        reminders: repo,
        deliver: async (reminder, info) => {
          delivered.push({ id: reminder.id, info });
        },
        clock,
        schedule,
        logger: silentLogger(),
      });
      // Due while the bot was off (an hour ago), and a daily one due an hour ago too.
      const missed = await repo.create(newReminder({ dueAt: START - 3_600_000 }));
      const daily = await repo.create(
        newReminder({ dueAt: START - 3_600_000, repeat: { every: 'day', interval: 1, localTime: '13:00:00' } }),
      );
      const soon = await repo.create(newReminder({ dueAt: START + 30_000 }));

      scheduler.start();
      await scheduler.idle();
      expect(delivered.map((d) => [d.id, d.info.late])).toEqual([[missed.id, true], [daily.id, true]]);
      expect(delivered[1]!.info.nextDueAt).toBe(zonedToEpoch({ year: 2026, month: 11, day: 27, hour: 13, minute: 0, second: 0 }, NY));
      expect((await repo.get('g', daily.id))?.dueAt).toBe(delivered[1]!.info.nextDueAt);

      schedule.advance(30_000);
      await scheduler.idle();
      await settle();
      expect(delivered.map((d) => d.id)).toEqual([missed.id, daily.id, soon.id]);
      expect(delivered[2]!.info.late).toBe(false);
      expect((await repo.get('g', soon.id))?.status).toBe('done');
      scheduler.stop();
      expect(schedule.count()).toBe(0);
    });

    it('picks up reminders added after it started, and keeps going when a delivery fails', async () => {
      const schedule = fakeSchedule(clock);
      const delivered: number[] = [];
      const scheduler = new ReminderScheduler({
        reminders: repo,
        deliver: async (reminder) => {
          delivered.push(reminder.id);
          if (reminder.message === 'broken') throw new Error('channel gone');
        },
        clock,
        schedule,
        logger: silentLogger(),
      });
      scheduler.start();
      await scheduler.idle();
      const broken = await repo.create(newReminder({ message: 'broken', dueAt: START + 5_000 }));
      const fine = await repo.create(newReminder({ dueAt: START + 5_000 }));
      scheduler.changed();
      await scheduler.idle();
      schedule.advance(5_000);
      await scheduler.idle();
      await settle();
      expect(delivered).toEqual([broken.id, fine.id]);
      expect((await repo.get('g', broken.id))?.status).toBe('done');
      scheduler.stop();
    });
  });

  describe('delivery', () => {
    const reminder = (overrides: Partial<Reminder> = {}): Reminder => ({
      ...newReminder(), id: 7, firedCount: 0, lastFiredAt: null, status: 'active', ...overrides,
    });
    const onTime: ReminderDeliveryInfo = { now: START + 60_000, late: false, nextDueAt: null };

    function setup(callMembers: Array<{ id: string }> | undefined, { postFails = false, announceWorks = true } = {}) {
      const sent: string[] = [];
      const deliver = createReminderDelivery({
        voice: {
          callMembers: () => callMembers,
          announce: async (_guildId, text) => {
            if (announceWorks) sent.push(`voice: ${text}`);
            return announceWorks;
          },
        },
        messenger: {
          postInChannel: async (_guildId, channelId, content, mention) => {
            if (postFails) throw new Error('missing access');
            sent.push(`#${channelId} (${mention}): ${content}`);
          },
          sendDirect: async (userId, content) => {
            sent.push(`dm ${userId}: ${content}`);
          },
        },
        logger: silentLogger(),
      });
      return { sent, deliver };
    }

    it("says it out loud when the person is in the call, otherwise posts in the channel it was set from", async () => {
      const inCall = setup([{ id: 'alice' }, { id: 'sam' }]);
      await inCall.deliver(reminder(), onTime);
      expect(inCall.sent).toEqual(["voice: Alice, here's your reminder: stretch."]);

      const elsewhere = setup([{ id: 'sam' }]);
      await elsewhere.deliver(reminder(), onTime);
      expect(elsewhere.sent).toEqual(['#chat (alice): ⏰ <@alice> Reminder: stretch']);

      const noCall = setup(undefined);
      await noCall.deliver(reminder({ audience: 'everyone' }), onTime);
      expect(noCall.sent).toEqual(['#chat (alice): ⏰ <@alice> Reminder for everyone, from Alice: stretch']);
    });

    it('announces reminders for everyone to whoever is in the call', async () => {
      const { sent, deliver } = setup([{ id: 'sam' }]);
      await deliver(reminder({ audience: 'everyone', message: 'start the raid' }), onTime);
      expect(sent).toEqual(['voice: Reminder for everyone, from Alice: start the raid.']);
    });

    it('falls back to a direct message when the channel is unusable', async () => {
      const { sent, deliver } = setup(undefined, { postFails: true });
      await deliver(reminder(), onTime);
      expect(sent).toEqual(['dm alice: ⏰ <@alice> Reminder: stretch']);
    });

    it('words timers, late deliveries and repeats', () => {
      const timer = reminder({ kind: 'timer', message: 'the pizza', durationMs: 600_000, dueAt: START });
      expect(spokenReminder(timer, { ...onTime, now: START })).toBe('Alice, your 10 minute timer for the pizza is done.');
      expect(spokenReminder({ ...timer, audience: 'everyone' }, { ...onTime, now: START })).toBe(
        "Time's up! The 10 minute timer Alice set for the pizza is done.",
      );
      expect(spokenReminder(timer, { now: START + 3_600_000, late: true, nextDueAt: null })).toBe(
        'Alice, your 10 minute timer for the pizza went off at 2:00 PM, while I was offline.',
      );
      expect(spokenReminder(reminder({ dueAt: START }), { now: START + 2 * 86_400_000, late: true, nextDueAt: null })).toBe(
        "Alice, here's your reminder: stretch. Sorry it's late; it was due on Thursday, November 26 at 2:00 PM, while I was offline.",
      );
      const weekly = reminder({ dueAt: START, repeat: { every: 'week', interval: 1, localTime: '14:00:00' } });
      expect(writtenReminder(weekly, { now: START + 600_000, late: true, nextDueAt: START + 7 * 86_400_000 })).toBe(
        [
          '⏰ <@alice> Reminder: stretch',
          `-# This was due <t:${START / 1000}:f>, but I was offline.`,
          `-# Repeats every week; next <t:${(START + 7 * 86_400_000) / 1000}:R>. To stop it, ask me to cancel reminder #7.`,
        ].join('\n'),
      );
    });
  });
});
