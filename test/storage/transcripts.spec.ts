import type { Storage } from '../../src/storage/open.js';
import { toFtsQuery } from '../../src/storage/sqlite/fts.js';
import { fakeClock } from '../helpers.js';
import { backends } from './backends.js';

describe('toFtsQuery', () => {
  it('quotes and ORs terms so model-written queries cannot break FTS syntax', () => {
    expect(toFtsQuery('Japan trip')).toBe('"japan" OR "trip"');
    expect(toFtsQuery('C++ AND (NEAR "x")')).toBe('"c" OR "and" OR "near" OR "x"');
    expect(toFtsQuery('  ¿¡ !! ')).toBeUndefined();
  });
});

describe.each(backends)('TranscriptRepository ($name)', (backend) => {
  let storage: Storage;
  let repo: Storage['transcripts'];

  beforeEach(async () => {
    storage = await backend.open(fakeClock());
    repo = storage.transcripts;
  });
  afterEach(() => storage.close());

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

  if (backend.name === 'sqlite') {
    it('prunes old segments and empty ended sessions', async () => {
      const session = await seed();
      await repo.endSession(session.id, 6_000);
      expect(await repo.pruneBefore(3_000)).toBe(3); // two in g1 and one in g2 started before 3s
      expect((await repo.readRange({ guildId: 'g1', limit: 10, order: 'oldest_first' })).segments).toHaveLength(3);
      expect(await repo.pruneBefore(10_000)).toBe(3);
      expect(await repo.listSessions('g1', { limit: 5 })).toEqual([]);
    });
  }

  it('keeps a session query to its own guild', async () => {
    const session = await seed();
    expect(await repo.search({ guildId: 'g2', sessionId: session.id, query: 'japan', limit: 5, contextSegments: 0 })).toEqual([]);
    expect((await repo.readRange({ guildId: 'g2', sessionId: session.id, limit: 10, order: 'oldest_first' })).segments).toEqual([]);
  });

  it('reads one session, a time range and one speaker, paging from either end', async () => {
    const session = await seed();
    const range = await repo.readRange({ guildId: 'g1', sessionId: session.id, since: 2_000, until: 4_000, limit: 10, order: 'oldest_first' });
    expect(range.segments.map((s) => s.speakerName)).toEqual(['Sam', 'Chase', 'Nimbus']);
    const sam = await repo.readRange({ guildId: 'g1', speaker: 'sam', limit: 1, order: 'newest_first' });
    expect(sam.segments.map((s) => s.text)).toEqual(['book by January then']);
    expect(sam.hasMore).toBe(true);
  });

  it('stores recaps and finds ended sessions that still need one', async () => {
    const long = await repo.startSession({ guildId: 'g1', channelId: 'vc1', channelName: 'General', startedAt: 10_000 });
    for (let i = 0; i < 6; i++) {
      await repo.appendSegment({
        sessionId: long.id, guildId: 'g1', channelId: 'vc1', speakerId: 'u', speakerName: 'Sam', isAssistant: false,
        text: `line ${i}`, startedAt: 10_000 + i, endedAt: 10_000 + i,
      });
    }
    const short = await repo.startSession({ guildId: 'g1', channelId: 'vc1', channelName: 'General', startedAt: 20_000 });
    await repo.appendSegment({
      sessionId: short.id, guildId: 'g1', channelId: 'vc1', speakerId: 'u', speakerName: 'Sam', isAssistant: false,
      text: 'hi', startedAt: 20_000, endedAt: 20_000,
    });
    const open = await repo.startSession({ guildId: 'g1', channelId: 'vc1', channelName: 'General', startedAt: 30_000 });

    expect(await repo.sessionsNeedingRecap(0, 6)).toEqual([]); // still open
    await repo.endSession(long.id, 15_000);
    await repo.endSession(short.id, 25_000);
    expect((await repo.sessionsNeedingRecap(0, 6)).map((s) => s.id)).toEqual([long.id]);
    expect(await repo.sessionsNeedingRecap(11_000, 6)).toEqual([]);

    await repo.setRecap(long.id, 'Sam read six lines.', 16_000);
    expect(await repo.sessionsNeedingRecap(0, 6)).toEqual([]);
    const listed = await repo.listSessions('g1', { limit: 10 });
    expect(listed.find((s) => s.id === long.id)?.recap).toBe('Sam read six lines.');
    expect(listed.find((s) => s.id === short.id)?.recap).toBeNull();
    expect(await repo.getSession(open.id)).toMatchObject({ id: open.id, endedAt: null });
    expect(await repo.getSession(999)).toBeUndefined();
  });
});
