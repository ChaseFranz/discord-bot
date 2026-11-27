import type { ToolContext } from '../../src/assistant/tools/types.js';
import { connectMemoryTools } from '../../src/memory/inProcess.js';
import { openDatabase, openMemoryDatabase, type SqliteDatabase } from '../../src/storage/sqlite/database.js';
import { SqliteConversationRepository } from '../../src/storage/sqlite/SqliteConversationRepository.js';
import { SqliteMemoryRepository } from '../../src/storage/sqlite/SqliteMemoryRepository.js';
import { SqliteTranscriptRepository } from '../../src/storage/sqlite/SqliteTranscriptRepository.js';

function context(guildId: string, userId: string, userDisplayName = userId): ToolContext {
  return { guildId, userId, userDisplayName, modality: 'text', voiceChannelId: undefined, textChannelId: 'chat', signals: { silenceRequested: false, stopRequested: false } };
}

describe('memory MCP server via McpToolProvider', () => {
  let db: SqliteDatabase;
  let memoryDb: SqliteDatabase;
  let memories: SqliteMemoryRepository;
  let transcripts: SqliteTranscriptRepository;
  let memory: Awaited<ReturnType<typeof connectMemoryTools>>;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    transcripts = new SqliteTranscriptRepository(db);
    const conversations = new SqliteConversationRepository(db);

    const home = await transcripts.startSession({ guildId: 'home', channelId: 'vc', channelName: 'General', startedAt: Date.UTC(2026, 10, 24, 20) });
    await transcripts.appendSegment({
      sessionId: home.id, guildId: 'home', channelId: 'vc', speakerId: 'u-sam', speakerName: 'Sam', isAssistant: false,
      text: 'we should go to Japan next spring', startedAt: Date.UTC(2026, 10, 24, 20, 5), endedAt: Date.UTC(2026, 10, 24, 20, 5, 4),
    });
    const other = await transcripts.startSession({ guildId: 'other', channelId: 'vc2', channelName: 'Secret', startedAt: 0 });
    await transcripts.appendSegment({
      sessionId: other.id, guildId: 'other', channelId: 'vc2', speakerId: 'u-x', speakerName: 'Xavier', isAssistant: false,
      text: 'our Japan surprise party', startedAt: 10, endedAt: 20,
    });
    await conversations.appendTurn({
      scope: { guildId: 'home', userId: 'alice' }, modality: 'text', createdAt: 1,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'my favourite band is Radiohead' }] }],
    });
    await conversations.appendTurn({
      scope: { guildId: 'home', userId: 'bob' }, modality: 'text', createdAt: 1,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'my favourite band is a secret' }] }],
    });

    memoryDb = openMemoryDatabase(':memory:');
    memories = new SqliteMemoryRepository(memoryDb);
    memory = await connectMemoryTools({ transcripts, conversations, memories });
  });

  afterEach(async () => {
    await memory.close();
    db.close();
    memoryDb.close();
  });

  it('exposes the memory tools without the scope parameters', () => {
    const tools = memory.provider.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'forget_memory',
      'list_voice_sessions',
      'read_voice_transcript',
      'remember',
      'search_memories',
      'search_my_conversation_history',
      'search_voice_transcripts',
      'update_memory',
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      for (const hidden of ['guild_id', 'user_id', 'user_name']) {
        expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain(hidden);
        expect(tool.inputSchema.required ?? []).not.toContain(hidden);
      }
      expect(tool.description.length).toBeGreaterThan(40);
    }
    const search = tools.find((t) => t.name === 'search_voice_transcripts')!;
    expect(search.inputSchema.required).toEqual(['query']);
  });

  it('searches transcripts only within the calling guild, even if the model passes another guild_id', async () => {
    const result = await memory.provider.callTool('search_voice_transcripts', { query: 'Japan', guild_id: 'other' }, context('home', 'alice'));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Sam: we should go to Japan next spring');
    expect(result.content).toContain('#General');
    expect(result.content).not.toContain('Xavier');
  });

  it("searches only the caller's own conversation history", async () => {
    const result = await memory.provider.callTool('search_my_conversation_history', { query: 'favourite band', user_id: 'bob' }, context('home', 'alice'));
    expect(result.content).toContain('Radiohead');
    expect(result.content).not.toContain('secret');
  });

  it('reads and lists sessions, with their recaps', async () => {
    const sessions = await memory.provider.callTool('list_voice_sessions', {}, context('home', 'alice'));
    expect(sessions.content).toMatch(/session \d+: #General, started 2026-11-24T20:00:00Z, still active; 1 lines; speakers: Sam$/);
    await transcripts.endSession(1, Date.UTC(2026, 10, 24, 21));
    await transcripts.setRecap(1, 'Sam suggested\na trip to Japan.', Date.UTC(2026, 10, 24, 21));
    const recapped = await memory.provider.callTool('list_voice_sessions', {}, context('home', 'alice'));
    expect(recapped.content).toContain('ended 2026-11-24T21:00:00Z; 1 lines; speakers: Sam\n  Recap: Sam suggested a trip to Japan.');
    const read = await memory.provider.callTool('read_voice_transcript', { since: '2026-11-24T00:00:00Z' }, context('home', 'alice'));
    expect(read.content).toContain('[2026-11-24T20:05:00Z] Sam: we should go to Japan next spring');
  });

  it('returns tool errors for bad input instead of throwing', async () => {
    const badTime = await memory.provider.callTool('read_voice_transcript', { since: 'last tuesday' }, context('home', 'alice'));
    expect(badTime.isError).toBe(true);
    expect(badTime.content).toContain('ISO-8601');

    const missingQuery = await memory.provider.callTool('search_voice_transcripts', {}, context('home', 'alice'));
    expect(missingQuery.isError).toBe(true);

    const unknown = await memory.provider.callTool('drop_tables', {}, context('home', 'alice'));
    expect(unknown.isError).toBe(true);
  });
  describe('long-term notes', () => {
    const ALICE = '100000000000000001';
    const SAM = '100000000000000002';
    const alice = () => context('home', ALICE, 'Alice');
    const sam = () => context('home', SAM, 'Sam');

    it('saves notes about the speaker, someone else, or the server, attributed to the speaker', async () => {
      // A model trying to save "as" someone else or into another server is overridden.
      expect((await memory.provider.callTool('remember', { fact: 'Is vegetarian', user_id: SAM, guild_id: 'other' }, alice())).content)
        .toBe('Saved note #1 about Alice.');
      expect((await memory.provider.callTool('remember', { fact: 'Birthday: May 3', about_user_id: SAM, about_name: 'Sam' }, alice())).content)
        .toBe('Saved note #2 about Sam.');
      expect((await memory.provider.callTool('remember', { fact: 'Movie night is Fridays', about_user_id: 'server' }, sam())).content)
        .toBe('Saved note #3 about the server.');

      const [first] = await memories.listAbout('home', [ALICE], 5);
      expect(first).toMatchObject({ subjectId: ALICE, subjectName: 'Alice', sourceUserId: ALICE, sourceName: 'Alice', text: 'Is vegetarian' });
      expect(await memories.listAbout('other', [ALICE, SAM, null], 5)).toEqual([]);
      const [birthday] = await memories.listAbout('home', [SAM], 5);
      expect(birthday).toMatchObject({ subjectName: 'Sam', sourceUserId: ALICE });
    });

    it('skips duplicates and rejects bad input', async () => {
      await memory.provider.callTool('remember', { fact: 'Is vegetarian' }, alice());
      expect((await memory.provider.callTool('remember', { fact: '  is   VEGETARIAN ' }, alice())).content).toBe('Already remembered as note #1 about Alice.');
      expect((await memory.provider.callTool('remember', { fact: 'x'.repeat(301) }, alice())).isError).toBe(true);
      expect((await memory.provider.callTool('remember', { fact: 'Likes jazz', about_user_id: 'Sam' }, alice())).content).toContain('Discord user ID');
    });

    it('lets only the subject or whoever told Nimbus change or delete a personal note', async () => {
      await memory.provider.callTool('remember', { fact: 'Birthday: May 3', about_user_id: SAM, about_name: 'Sam' }, alice());
      const ZOE = context('home', '100000000000000003', 'Zoe');
      const denied = await memory.provider.callTool('forget_memory', { memory_id: 1 }, ZOE);
      expect(denied).toEqual({ content: 'Note #1 is about Sam; only they (or Alice, who told you) can change or delete it.', isError: true });
      expect((await memory.provider.callTool('update_memory', { memory_id: 1, fact: 'Birthday: May 4' }, sam())).content).toBe('Updated note #1 about Sam.');
      expect((await memories.get('home', 1))?.text).toBe('Birthday: May 4');
      expect((await memory.provider.callTool('forget_memory', { memory_id: 1 }, alice())).content).toBe('Forgot note #1 about Sam.');
      expect((await memory.provider.callTool('forget_memory', { memory_id: 1 }, alice())).isError).toBe(true);
    });

    it('searches notes by words or by person', async () => {
      await memory.provider.callTool('remember', { fact: 'Favourite game is Hades' }, sam());
      await memory.provider.callTool('remember', { fact: 'Plays guitar' }, alice());
      const byWord = await memory.provider.callTool('search_memories', { query: 'game' }, alice());
      expect(byWord.content).toMatch(/^- #1 about Sam: Favourite game is Hades \(from them, \d{4}-\d{2}-\d{2}\)$/);
      const byPerson = await memory.provider.callTool('search_memories', { about_user_id: ALICE }, sam());
      expect(byPerson.content).toContain('Plays guitar');
      expect(byPerson.content).not.toContain('Hades');
      // A person's notes come back even when the query's words don't appear in them.
      const personAndQuery = await memory.provider.callTool('search_memories', { about_user_id: SAM, query: 'food dinner' }, alice());
      expect(personAndQuery.content).toContain('Favourite game is Hades');
      expect((await memory.provider.callTool('search_memories', {}, sam())).isError).toBe(true);
    });
  });
});
