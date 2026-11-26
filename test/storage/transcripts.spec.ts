import { openDatabase, type SqliteDatabase } from '../../src/storage/sqlite/database.js';
import { toFtsQuery } from '../../src/storage/sqlite/fts.js';
import { SqliteTranscriptRepository } from '../../src/storage/sqlite/SqliteTranscriptRepository.js';

describe('toFtsQuery', () => {
  it('quotes and ORs terms so model-written queries cannot break FTS syntax', () => {
    expect(toFtsQuery('Japan trip')).toBe('"japan" OR "trip"');
    expect(toFtsQuery('C++ AND (NEAR "x")')).toBe('"c" OR "and" OR "near" OR "x"');
    expect(toFtsQuery('  ¿¡ !! ')).toBeUndefined();
  });
});

describe('SqliteTranscriptRepository', () => {
  let db: SqliteDatabase;
  let repo: SqliteTranscriptRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteTranscriptRepository(db);
  });
  afterEach(() => db.close());

  async function seed() {
    const s1 = await repo.startSession({ guildId: 'g1', channelId: 'vc1', channelName: 'General', startedAt: 1_000 });
    const lines: Array<[string, string, string, boolean?]> = [
      ['u-alex', 'Alex', 'did anyone watch the game'],
      ['u-sam', 'Sam', 'we should plan a trip to Japan next spring'],
      ['u-chase', 'Chase', 'Japan sounds great but flights are pricey'],
      ['bot', 'Nimbus', 'Flights to Tokyo are cheapest in January.', true],
      ['u-sam', 'Sam', 'book by January then'],
    ];
    for (const [index, [speakerId, speakerName, text, isAssistant]] of lines.entries()) {
      await repo.appendSegment({
        sessionId: s1.id, guildId: 'g1', channelId: 'vc1', speakerId, speakerName,
        isAssistant: isAssistant ?? false, text, startedAt: 1_000 + index * 1_000, endedAt: 1_500 + index * 1_000,
      });
    }
    const other = await repo.startSession({ guildId: 'g2', channelId: 'vc9', channelName: 'Elsewhere', startedAt: 1_000 });
    await repo.appendSegment({
      sessionId: other.id, guildId: 'g2', channelId: 'vc9', speakerId: 'x', speakerName: 'Xavier',
      isAssistant: false, text: 'secret Japan plans', startedAt: 1_000, endedAt: 1_100,
    });
    return s1;
  }

  it('finds matching lines with surrounding context and channel name, scoped to the guild', async () => {
    const session = await seed();
    const hits = await repo.search({ guildId: 'g1', query: 'japan', limit: 5, contextSegments: 1 });
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.hit.guildId === 'g1')).toBe(true);
    expect(hits[0]!.channelName).toBe('General');
    const samHit = hits.find((h) => h.hit.speakerName === 'Sam')!;
    expect(samHit.hit.sessionId).toBe(session.id);
    expect(samHit.context.map((s) => s.speakerName)).toEqual(['Alex', 'Sam', 'Chase']);
  });

  it('filters by speaker name (partial, case-insensitive), id, and time', async () => {
    await seed();
    expect((await repo.search({ guildId: 'g1', query: 'japan', speaker: 'sa', limit: 5, contextSegments: 0 })).map((h) => h.hit.speakerName)).toEqual(['Sam']);
    expect((await repo.search({ guildId: 'g1', query: 'japan', speaker: 'u-chase', limit: 5, contextSegments: 0 })).map((h) => h.hit.speakerName)).toEqual(['Chase']);
    expect(await repo.search({ guildId: 'g1', query: 'japan', since: 2_500, limit: 5, contextSegments: 0 })).toHaveLength(1);
    expect(await repo.search({ guildId: 'g1', query: 'japan', speaker: '50%_off\\', limit: 5, contextSegments: 0 })).toEqual([]);
  });

  it('stems words (porter tokenizer)', async () => {
    await seed();
    const hits = await repo.search({ guildId: 'g1', query: 'flight booking', limit: 5, contextSegments: 0 });
    expect(hits.map((h) => h.hit.text)).toEqual(
      expect.arrayContaining(['Japan sounds great but flights are pricey', 'book by January then']),
    );
  });

  it('reads ranges from either end, oldest first, and reports more', async () => {
    await seed();
    const newest = await repo.readRange({ guildId: 'g1', limit: 2, order: 'newest_first' });
    expect(newest.segments.map((s) => s.text)).toEqual(['Flights to Tokyo are cheapest in January.', 'book by January then']);
    expect(newest.hasMore).toBe(true);
    const oldest = await repo.readRange({ guildId: 'g1', limit: 10, order: 'oldest_first' });
    expect(oldest.segments).toHaveLength(5);
    expect(oldest.hasMore).toBe(false);
  });

  it('lists sessions with human participants and counts', async () => {
    await seed();
    const [session] = await repo.listSessions('g1', { limit: 5 });
    expect(session!.participants).toEqual(['Alex', 'Chase', 'Sam']);
    expect(session!.segmentCount).toBe(5);
    expect(session!.lastActivityAt).toBe(5_500);
    expect(await repo.listSessions('g1', { since: 1_000_000, limit: 5 })).toHaveLength(1); // still open
  });

  it('returns recent segments of one session, oldest first, capped to the newest', async () => {
    const session = await seed();
    const recent = await repo.recentSegments(session.id, 2_000, 2);
    expect(recent.map((s) => s.text)).toEqual(['Flights to Tokyo are cheapest in January.', 'book by January then']);
  });

  it('closes sessions left open at their last activity', async () => {
    await seed();
    expect(await repo.endOpenSessions(9_999_999)).toBe(2);
    const [session] = await repo.listSessions('g1', { limit: 1 });
    expect(session!.endedAt).toBe(5_500);
  });

  it('prunes old segments and empty ended sessions', async () => {
    const session = await seed();
    await repo.endSession(session.id, 6_000);
    expect(await repo.pruneBefore(3_000)).toBe(3); // two in g1 and one in g2 started before 3s
    expect((await repo.readRange({ guildId: 'g1', limit: 10, order: 'oldest_first' })).segments).toHaveLength(3);
    expect(await repo.pruneBefore(10_000)).toBe(3);
    expect(await repo.listSessions('g1', { limit: 5 })).toEqual([]);
  });
});
