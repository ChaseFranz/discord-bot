import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoHelperRegistry, DynamoMusicJobBoard, S3AudioRelayStore } from '../../src/aws/musicRelay.js';
import { MemoryHelperRegistry, MemoryMusicJobBoard } from '../../src/music/relay/memory.js';
import type { HelperRegistry, MusicJobBoard } from '../../src/music/relay/ports.js';
import { createDocumentClient } from '../../src/storage/dynamodb/dynamo.js';
import { fakeClock } from '../helpers.js';
import { backends, dynamoEndpoint, localAdminClient, type TestStorage } from '../storage/backends.js';

const GUILD = '1083158655429509190';
const ALICE = { userId: '100000000000000001', userName: 'Alice' };
const SAM = { userId: '100000000000000002', userName: 'Sam' };
const T0 = Date.UTC(2026, 10, 27, 20, 0, 0);

interface Opened {
  registry: HelperRegistry;
  board: MusicJobBoard;
  table?: string;
  close(): Promise<void>;
}

/** The same behaviour is expected in memory and in DynamoDB (when DynamoDB Local is there, as in CI). */
const stores: Array<{ name: string; open(): Promise<Opened> }> = [
  { name: 'memory', open: async () => ({ registry: new MemoryHelperRegistry(), board: new MemoryMusicJobBoard(), close: async () => undefined }) },
];
if (dynamoEndpoint) {
  stores.push({
    name: 'dynamodb',
    open: async () => {
      const storage: TestStorage = await backends.find((backend) => backend.name === 'dynamodb')!.open(fakeClock());
      const doc = createDocumentClient({ region: 'us-east-1', endpoint: dynamoEndpoint });
      const table = storage.tables!.main;
      return {
        registry: new DynamoHelperRegistry(doc, table),
        board: new DynamoMusicJobBoard(doc, table),
        table,
        close: async () => {
          doc.destroy();
          await storage.close();
        },
      };
    },
  });
}

describe.each(stores)('music helper records ($name)', ({ open }) => {
  let opened: Opened;
  let registry: HelperRegistry;
  let board: MusicJobBoard;

  beforeEach(async () => {
    opened = await open();
    ({ registry, board } = opened);
  });
  afterEach(() => opened.close());

  const register = (who: typeof ALICE, secretHash = 'a'.repeat(64)) => registry.register({ guildId: GUILD, ...who, secretHash, createdAt: T0 });

  it('keeps registrations per person and server, replacing an earlier one', async () => {
    await register(ALICE);
    await register(SAM);
    await registry.register({ guildId: '999999999999', ...ALICE, secretHash: 'c'.repeat(64), createdAt: T0 });
    expect(await registry.find(GUILD, ALICE.userId)).toEqual({ guildId: GUILD, ...ALICE, secretHash: 'a'.repeat(64), createdAt: T0, lastSeenAt: null, version: null });
    expect((await registry.list(GUILD)).map((registration) => registration.userName).sort()).toEqual(['Alice', 'Sam']);

    await registry.checkIn(GUILD, ALICE.userId, T0 + 5_000, '1.0.0');
    expect(await registry.find(GUILD, ALICE.userId)).toMatchObject({ lastSeenAt: T0 + 5_000, version: '1.0.0' });
    // A new code is a fresh start: the old hash is gone, and so is the last check-in.
    await register(ALICE, 'b'.repeat(64));
    expect(await registry.find(GUILD, ALICE.userId)).toMatchObject({ secretHash: 'b'.repeat(64), lastSeenAt: null, version: null });
  });

  it("removes a registration, and a late check-in doesn't bring it back", async () => {
    await register(ALICE);
    expect(await registry.remove(GUILD, ALICE.userId)).toBe(true);
    expect(await registry.remove(GUILD, ALICE.userId)).toBe(false);
    await registry.checkIn(GUILD, ALICE.userId, T0 + 5_000, '1.0.0');
    expect(await registry.find(GUILD, ALICE.userId)).toBeUndefined();
    expect(await registry.list(GUILD)).toEqual([]);
  });

  it('gives each waiting job to one helper only, oldest first, and never a stale one', async () => {
    const stale = await board.post(GUILD, 'ytsearch1:too old', T0 - 60_000);
    const first = await board.post(GUILD, 'ytsearch1:first', T0);
    const second = await board.post(GUILD, 'ytsearch1:second', T0 + 1_000);
    await board.post('999999999999', 'ytsearch1:another server', T0);
    expect(first).toMatchObject({ guildId: GUILD, target: 'ytsearch1:first', status: 'waiting', helper: null, track: null, chunks: 0, error: null });

    const [a, b] = await Promise.all([board.claim(GUILD, ALICE, T0 + 2_000, T0 - 30_000), board.claim(GUILD, SAM, T0 + 2_000, T0 - 30_000)]);
    expect([a!.id, b!.id].sort()).toEqual([first.id, second.id].sort());
    expect(await board.claim(GUILD, ALICE, T0 + 3_000, T0 - 30_000)).toBeUndefined();
    expect(await board.get(GUILD, stale.id)).toMatchObject({ status: 'waiting' });
    expect(await board.get(GUILD, a!.id)).toMatchObject({ status: 'claimed', helper: ALICE, updatedAt: T0 + 2_000 });
    expect(await board.get(GUILD, 'no-such-job')).toBeUndefined();
  });

  it("follows a job through found, progress and done, from the helper that holds it", async () => {
    const job = await board.post(GUILD, 'ytsearch1:jelly fish jam', T0);
    // Nobody holds it yet.
    expect(await board.report(GUILD, job.id, ALICE.userId, { kind: 'progress', chunks: 1 }, T0)).toBe(false);
    await board.claim(GUILD, ALICE, T0 + 500, T0);
    expect(await board.report(GUILD, job.id, SAM.userId, { kind: 'progress', chunks: 1 }, T0 + 600)).toBe(false);

    const track = { videoId: 'oWqAf4eex14', title: 'jellyfish jam', durationSeconds: 151 };
    expect(await board.report(GUILD, job.id, ALICE.userId, { kind: 'found', track }, T0 + 1_000)).toBe(true);
    expect(await board.get(GUILD, job.id)).toMatchObject({ status: 'found', track, chunks: 0 });
    expect(await board.report(GUILD, job.id, ALICE.userId, { kind: 'progress', chunks: 3 }, T0 + 2_000)).toBe(true);
    // A report that arrives late is accepted, but progress never goes backwards.
    expect(await board.report(GUILD, job.id, ALICE.userId, { kind: 'progress', chunks: 2 }, T0 + 2_100)).toBe(true);
    expect(await board.get(GUILD, job.id)).toMatchObject({ status: 'found', chunks: 3 });
    expect(await board.report(GUILD, job.id, ALICE.userId, { kind: 'done', chunks: 5 }, T0 + 3_000)).toBe(true);
    expect(await board.get(GUILD, job.id)).toMatchObject({ status: 'done', chunks: 5, track, updatedAt: T0 + 3_000 });
    // Over: nothing more is accepted, and it can't be abandoned.
    expect(await board.report(GUILD, job.id, ALICE.userId, { kind: 'progress', chunks: 9 }, T0 + 4_000)).toBe(false);
    await board.abandon(GUILD, job.id, 'too late', T0 + 5_000);
    expect(await board.get(GUILD, job.id)).toMatchObject({ status: 'done', error: null });
  });

  it('notes when the bot is listening to a job that is still going', async () => {
    const job = await board.post(GUILD, 'ytsearch1:lofi hip hop radio', T0);
    expect(job.listenedAt).toBeNull();
    // Nobody holds it yet: there is nothing to listen to.
    await board.listening(GUILD, job.id, T0 + 500);
    expect(await board.get(GUILD, job.id)).toMatchObject({ listenedAt: null });

    await board.claim(GUILD, ALICE, T0 + 1_000, T0);
    const track = { videoId: 'rFZHOHl-L8A', title: 'lofi hip hop radio', live: true };
    await board.report(GUILD, job.id, ALICE.userId, { kind: 'found', track }, T0 + 2_000);
    await board.listening(GUILD, job.id, T0 + 3_000);
    expect(await board.get(GUILD, job.id)).toMatchObject({ status: 'found', track, listenedAt: T0 + 3_000 });
    await board.listening(GUILD, job.id, T0 + 23_000);
    expect(await board.get(GUILD, job.id)).toMatchObject({ listenedAt: T0 + 23_000 });

    // Over: it is left as it was.
    await board.abandon(GUILD, job.id, 'no longer wanted', T0 + 30_000);
    await board.listening(GUILD, job.id, T0 + 43_000);
    expect(await board.get(GUILD, job.id)).toMatchObject({ status: 'failed', listenedAt: T0 + 23_000 });
    await board.listening(GUILD, 'no-such-job', T0);
  });

  it('records a failure, and lets the bot give up on a job', async () => {
    const failing = await board.post(GUILD, 'ytsearch1:one', T0);
    await board.claim(GUILD, ALICE, T0, T0);
    expect(await board.report(GUILD, failing.id, ALICE.userId, { kind: 'failed', error: 'Video unavailable' }, T0 + 1_000)).toBe(true);
    expect(await board.get(GUILD, failing.id)).toMatchObject({ status: 'failed', error: 'Video unavailable' });

    const ignored = await board.post(GUILD, 'ytsearch1:two', T0 + 2_000);
    await board.abandon(GUILD, ignored.id, 'No music helper picked that up.', T0 + 15_000);
    expect(await board.get(GUILD, ignored.id)).toMatchObject({ status: 'failed', error: 'No music helper picked that up.' });
    expect(await board.claim(GUILD, ALICE, T0 + 16_000, T0)).toBeUndefined();
    await board.abandon(GUILD, 'no-such-job', 'nothing to do', T0);
  });

  if (dynamoEndpoint) {
    it('stores a job under an upper-case key that sorts by age, and expires it a day later', async () => {
      if (!opened.table) return;
      const job = await board.post(GUILD, 'ytsearch1:jelly fish jam', T0);
      expect(job.id).toMatch(/^\d{15}-[0-9a-f]{12}$/);
      const admin = localAdminClient();
      const stored = await admin.send(
        new GetItemCommand({ TableName: opened.table, Key: { pk: { S: `MUSICJOB#${GUILD}` }, sk: { S: `JOB#${job.id}` } } }),
      );
      admin.destroy();
      expect(stored.Item?.expiresAt?.N).toBe(String(Math.floor(T0 / 1000) + 86_400));

      // A stream that is being listened to is kept for a day from then, however long it has been going.
      await board.claim(GUILD, ALICE, T0, T0);
      await board.listening(GUILD, job.id, T0 + 7_200_000);
      const later = localAdminClient();
      const kept = await later.send(new GetItemCommand({ TableName: opened.table, Key: { pk: { S: `MUSICJOB#${GUILD}` }, sk: { S: `JOB#${job.id}` } } }));
      later.destroy();
      expect(kept.Item?.expiresAt?.N).toBe(String(Math.floor(T0 / 1000) + 7_200 + 86_400));
    });
  }
});

describe('S3AudioRelayStore', () => {
  // Signing happens locally: no request is made, so made-up credentials do.
  const s3 = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' } });
  const store = new S3AudioRelayStore(s3, 'nimbus-music-relay');

  it('gives a helper a form that lets it write only under its own job, in chunks of limited size', async () => {
    const target = await store.uploadTarget(GUILD, 'job-1');
    expect(target.url).toBe('https://nimbus-music-relay.s3.us-east-1.amazonaws.com/');
    expect(target.keyPrefix).toBe(`music/${GUILD}/job-1/`);
    expect(target.maxChunkBytes).toBe(4 * 1024 * 1024);
    expect(target.expiresInSeconds).toBe(30 * 60);
    // The helper supplies the key for each chunk itself.
    expect(target.fields).not.toHaveProperty('key');
    const policy = JSON.parse(Buffer.from(target.fields.Policy!, 'base64').toString('utf8')) as { conditions: unknown[]; expiration: string };
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        ['starts-with', '$key', `music/${GUILD}/job-1/`],
        ['content-length-range', 1, 4 * 1024 * 1024],
        { bucket: 'nimbus-music-relay' },
      ]),
    );
    const minutes = (Date.parse(policy.expiration) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(28);
    expect(minutes).toBeLessThan(31);
  });

  it('reads a chunk back, and says nothing is there when it is not', async () => {
    const asked: string[] = [];
    const failing = (name: string) => Object.assign(new Error(name), { name });
    const fake = {
      send: async (command: { input: { Bucket: string; Key: string } }) => {
        asked.push(`${command.input.Bucket}/${command.input.Key}`);
        if (command.input.Key.endsWith('000001')) throw failing('NoSuchKey');
        if (command.input.Key.endsWith('000002')) throw failing('AccessDenied');
        if (command.input.Key.endsWith('000003')) throw failing('SlowDown');
        return { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
      },
    } as unknown as S3Client;
    const reading = new S3AudioRelayStore(fake, 'nimbus-music-relay');
    expect(await reading.read(GUILD, 'job-1', 0)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await reading.read(GUILD, 'job-1', 1)).toBeUndefined();
    expect(await reading.read(GUILD, 'job-1', 2)).toBeUndefined();
    await expect(reading.read(GUILD, 'job-1', 3)).rejects.toThrow('SlowDown');
    expect(asked[0]).toBe(`nimbus-music-relay/music/${GUILD}/job-1/000000`);
  });
});
