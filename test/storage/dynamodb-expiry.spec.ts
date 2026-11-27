import { GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { fakeClock } from '../helpers.js';
import { backends, dynamoEndpoint, localAdminClient, type TestStorage } from './backends.js';

const dynamodb = backends.find((backend) => backend.name === 'dynamodb');
const DAY = 86_400_000;

/** Where SQLite runs a retention sweep, DynamoDB items carry an expiry that TTL acts on. */
(dynamodb ? describe : describe.skip)('DynamoDB expiry (TTL) instead of the retention sweep', () => {
  let storage: TestStorage;
  const admin = () => localAdminClient();
  const clock = fakeClock(Date.UTC(2026, 10, 26));

  beforeEach(async () => {
    storage = await dynamodb!.open(clock, { retentionDays: 30 });
  });
  afterEach(() => storage.close());

  async function items(prefix: string): Promise<Array<Record<string, unknown>>> {
    const client = admin();
    const table = storage.tables!.main;
    const result = await client.send(
      new QueryCommand({ TableName: table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': { S: prefix } } }),
    );
    client.destroy();
    return (result.Items ?? []).map((item) => unmarshall(item));
  }

  it('gives transcript lines and ended sessions an expiry 30 days out', async () => {
    const t0 = Date.UTC(2026, 10, 1);
    const session = await storage.transcripts.startSession({ guildId: 'g', channelId: 'vc', channelName: 'General', startedAt: t0 });
    await storage.transcripts.appendSegment({
      sessionId: session.id, guildId: 'g', channelId: 'vc', speakerId: 'u', speakerName: 'Sam', isAssistant: false,
      text: 'hello', startedAt: t0, endedAt: t0 + 1_000,
    });
    await storage.transcripts.endSession(session.id, t0 + 5_000);
    const rows = await items(`SESSION#${session.id}`);
    const meta = rows.find((row) => row.sk === 'META')!;
    const line = rows.find((row) => String(row.sk).startsWith('SEG#'))!;
    expect(line.expiresAt).toBe(Math.floor((t0 + 30 * DAY) / 1000));
    expect(meta.expiresAt).toBe(Math.floor((t0 + 5_000 + 30 * DAY) / 1000));
  });

  it('gives messages an expiry only once they leave the active window', async () => {
    const scope = { guildId: 'g', userId: 'alice' };
    for (let n = 1; n <= 3; n++) {
      await storage.conversations.appendTurn({
        scope, modality: 'text', createdAt: n * DAY,
        messages: [{ role: 'user', content: [{ type: 'text', text: `q${n}` }] }, { role: 'assistant', content: [{ type: 'text', text: `a${n}` }] }],
      });
    }
    await storage.conversations.trimWindow(scope, { maxMessages: 4, keepMessages: 2 });
    const rows = (await items('THREAD#g#alice')).filter((row) => String(row.sk).startsWith('MSG#'));
    expect(rows.map((row) => [row.seq, row.expiresAt === undefined ? 'kept' : 'expires'])).toEqual([
      [1, 'expires'], [2, 'expires'], [3, 'expires'], [4, 'expires'], [5, 'kept'], [6, 'kept'],
    ]);
    expect(rows[0]!.expiresAt).toBe(Math.floor((DAY + 30 * DAY) / 1000));
  });

  it('expires finished reminders', async () => {
    const reminder = await storage.reminders.create({
      guildId: 'g', userId: 'alice', userName: 'Alice', kind: 'reminder', message: 'stretch', audience: 'me', channelId: 'chat',
      dueAt: clock() + 1_000, repeat: null, timeZone: 'UTC', durationMs: null, createdAt: clock(),
    });
    await storage.reminders.markFired(reminder.id, clock() + 1_000, null);
    const client = admin();
    const row = await client.send(new GetItemCommand({ TableName: storage.tables!.main, Key: { pk: { S: `REMINDER#${reminder.id}` }, sk: { S: 'REMINDER' } } }));
    client.destroy();
    const item = unmarshall(row.Item!);
    expect(item.expiresAt).toBe(Math.floor((clock() + 1_000 + 30 * DAY) / 1000));
    expect(item.gsi2pk).toBeUndefined();
  });
});

if (!dynamoEndpoint) {
  test.skip('DynamoDB tests need DYNAMODB_ENDPOINT (a DynamoDB Local); they run in CI', () => undefined);
}
