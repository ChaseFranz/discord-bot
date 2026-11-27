import { DeleteItemCommand, GetItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { NewReminder } from '../../src/storage/ports.js';
import { fakeClock } from '../helpers.js';
import { backends, localAdminClient, type TestStorage } from './backends.js';

const dynamodb = backends.find((backend) => backend.name === 'dynamodb');
const START = Date.UTC(2026, 10, 27, 12);
// Discord IDs are numbers; words here would look like type names to the key check.
const GUILD = '1083158655429509190';
const ALICE = '100000000000000001';
const KEY_ATTRIBUTES = ['pk', 'sk', 'gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk'] as const;

const reminder = (overrides: Partial<NewReminder> = {}): NewReminder => ({
  guildId: GUILD, userId: ALICE, userName: 'Alice', kind: 'reminder', message: 'stretch', audience: 'me', channelId: 'chat',
  dueAt: START + 60_000, repeat: null, timeZone: 'America/Chicago', durationMs: null, createdAt: START, ...overrides,
});

(dynamodb ? describe : describe.skip)('DynamoDB keys', () => {
  let storage: TestStorage;
  const clock = fakeClock(START);
  const admin = localAdminClient();

  beforeEach(async () => {
    storage = await dynamodb!.open(clock);
  });
  afterEach(() => storage.close());
  afterAll(() => admin.destroy());

  const note = (text: string) =>
    storage.memories.add({ guildId: GUILD, subjectId: ALICE, subjectName: 'Alice', text, sourceUserId: ALICE, sourceName: 'Alice', createdAt: START });

  async function scan(table: string): Promise<Array<Record<string, unknown>>> {
    const items: Array<Record<string, unknown>> = [];
    let start: Record<string, never> | undefined;
    do {
      const page = await admin.send(new ScanCommand({ TableName: table, ExclusiveStartKey: start }));
      items.push(...(page.Items ?? []).map((item) => unmarshall(item)));
      start = page.LastEvaluatedKey as Record<string, never> | undefined;
    } while (start);
    return items;
  }

  it('writes type names and markers in upper case, in every key of both tables', async () => {
    const scope = { guildId: GUILD, userId: ALICE };
    await storage.conversations.appendTurn({
      scope, modality: 'text', createdAt: START,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }],
    });
    const ended = await storage.transcripts.startSession({ guildId: GUILD, channelId: 'vc', channelName: 'General', startedAt: START });
    await storage.transcripts.appendSegment({
      sessionId: ended.id, guildId: GUILD, channelId: 'vc', speakerId: ALICE, speakerName: 'Alice', isAssistant: false,
      text: 'hello', startedAt: START, endedAt: START + 1_000,
    });
    await storage.transcripts.endSession(ended.id, START + 5_000); // now waiting for a recap
    await storage.transcripts.startSession({ guildId: GUILD, channelId: 'vc', channelName: 'General', startedAt: START + 10_000 }); // still open
    await storage.settings.update(scope, { privacy: 'requests' });
    await storage.usage.add(GUILD, '2026-11-27', [{ metric: 'claude.claude-haiku-5-5.output_tokens', quantity: 10, costUsd: 0.000005 }]);
    await storage.reminders.create(reminder());
    await note('likes jazz');

    // A part made only of letters and underscores is a type name or a marker. Data (Discord IDs,
    // padded numbers, dates, model and metric names) always has a digit, dot or dash in it.
    const lowerCase: string[] = [];
    for (const table of [storage.tables!.main, storage.tables!.memory]) {
      for (const item of await scan(table)) {
        for (const attribute of KEY_ATTRIBUTES) {
          const value = item[attribute];
          if (typeof value !== 'string') continue;
          if (value.split('#').some((part) => /^[A-Za-z_]+$/.test(part) && part !== part.toUpperCase())) lowerCase.push(`${attribute}=${value}`);
        }
      }
    }
    expect(lowerCase).toEqual([]);
  });

  it('never overwrites a note, session or reminder when a counter falls behind', async () => {
    const resetCounter = async (table: string, counter: string) => {
      const key = { pk: { S: 'COUNTER' }, sk: { S: counter } };
      expect((await admin.send(new GetItemCommand({ TableName: table, Key: key }))).Item).toBeDefined();
      await admin.send(new DeleteItemCommand({ TableName: table, Key: key }));
    };

    const first = await note('first');
    await resetCounter(storage.tables!.memory, `NOTE#${GUILD}`);
    const second = await note('second');
    expect(second.id).not.toBe(first.id);
    expect((await storage.memories.get(GUILD, first.id))?.text).toBe('first');

    const session = await storage.transcripts.startSession({ guildId: GUILD, channelId: 'vc', channelName: 'General', startedAt: START });
    await resetCounter(storage.tables!.main, 'SESSION');
    const nextSession = await storage.transcripts.startSession({ guildId: GUILD, channelId: 'other', channelName: 'Other', startedAt: START + 1 });
    expect(nextSession.id).not.toBe(session.id);
    expect((await storage.transcripts.getSession(session.id))?.channelId).toBe('vc');

    const firstReminder = await storage.reminders.create(reminder({ message: 'first' }));
    await resetCounter(storage.tables!.main, 'REMINDER');
    const secondReminder = await storage.reminders.create(reminder({ message: 'second' }));
    expect(secondReminder.id).not.toBe(firstReminder.id);
    expect((await storage.reminders.get(GUILD, firstReminder.id))?.message).toBe('first');
  });
});
