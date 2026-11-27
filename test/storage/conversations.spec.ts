import type { ConversationMessage, UserScope } from '../../src/storage/ports.js';
import type { Storage } from '../../src/storage/open.js';
import { fakeClock } from '../helpers.js';
import { backends } from './backends.js';

const alice: UserScope = { guildId: 'g1', userId: 'alice' };
const bob: UserScope = { guildId: 'g1', userId: 'bob' };

const user = (text: string): ConversationMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string): ConversationMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });

describe.each(backends)('ConversationRepository ($name)', (backend) => {
  let storage: Storage;
  let repo: Storage['conversations'];

  beforeEach(async () => {
    storage = await backend.open(fakeClock());
    repo = storage.conversations;
  });
  afterEach(() => storage.close());

  async function exchange(scope: UserScope, n: number, createdAt = 1_000) {
    await repo.appendTurn({ scope, modality: 'text', messages: [user(`question ${n}`), assistant(`answer ${n}`)], createdAt });
  }

  it('round-trips turns in order, per person', async () => {
    await exchange(alice, 1);
    await exchange(bob, 1);
    await repo.appendTurn({
      scope: alice,
      modality: 'voice',
      createdAt: 2_000,
      messages: [
        user('[voice] play jazz'),
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'play_music', input: { query: 'jazz' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Now playing' }] },
        assistant('Playing jazz.'),
      ],
    });

    const active = await repo.loadActive(alice);
    expect(active.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(active[2]!.modality).toBe('voice');
    expect(active[2]!.createdAt).toBe(2_000);
    expect(active[3]!.content).toEqual([{ type: 'tool_use', id: 't1', name: 'play_music', input: { query: 'jazz' } }]);
    expect(await repo.loadActive(bob)).toHaveLength(2);
  });

  it('keeps every message when the same person sends two turns at once', async () => {
    await Promise.all([exchange(alice, 1), exchange(alice, 2), exchange(alice, 3)]);
    const active = await repo.loadActive(alice);
    expect(active).toHaveLength(6);
    // Each turn stays together, user then assistant.
    for (let i = 0; i < 6; i += 2) {
      const n = (active[i]!.content[0] as { text: string }).text.replace('question ', '');
      expect(active[i + 1]!.content).toEqual([{ type: 'text', text: `answer ${n}` }]);
    }
  });

  it('refuses a turn that does not start with the user', async () => {
    await expect(repo.appendTurn({ scope: alice, modality: 'text', messages: [assistant('hi')], createdAt: 1 })).rejects.toThrow();
  });

  it('trims the window at a turn boundary and never below keepMessages', async () => {
    for (let n = 1; n <= 6; n++) await exchange(alice, n); // 12 messages
    expect(await repo.trimWindow(alice, { maxMessages: 12, keepMessages: 6 })).toBe(0); // not over max yet

    await exchange(alice, 7); // 14 messages
    const removed = await repo.trimWindow(alice, { maxMessages: 12, keepMessages: 5 });
    expect(removed).toBe(10); // keeps the last 2 full turns (4 messages <= 5)
    const active = await repo.loadActive(alice);
    expect(active).toHaveLength(4);
    expect(active[0]!.role).toBe('user');
    expect(active[0]!.content).toEqual([{ type: 'text', text: 'question 6' }]);
  });

  it('keeps only the latest turn when a single turn is longer than keepMessages', async () => {
    await exchange(alice, 1);
    await repo.appendTurn({
      scope: alice,
      modality: 'text',
      createdAt: 1,
      messages: [user('big'), assistant('a'), user('b'), assistant('c'), user('d'), assistant('e')],
    });
    await repo.trimWindow(alice, { maxMessages: 4, keepMessages: 2 });
    const active = await repo.loadActive(alice);
    expect(active[0]!.content).toEqual([{ type: 'text', text: 'big' }]);
    expect(active).toHaveLength(6);
  });

  it("searches the person's own history, including archived messages", async () => {
    await repo.appendTurn({ scope: alice, modality: 'text', createdAt: 1, messages: [user('recommend a book about Japan'), assistant('Try "The Wind-Up Bird Chronicle".')] });
    for (let n = 1; n <= 4; n++) await exchange(alice, n);
    await exchange(bob, 99);
    await repo.trimWindow(alice, { maxMessages: 4, keepMessages: 2 });

    const hits = await repo.search(alice, 'book Japan', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.archived).toBe(true);
    expect(hits[0]!.role).toBe('user');
    expect(hits.map((h) => h.text).join(' ')).toContain('Japan');
    expect(await repo.search(bob, 'Japan', 5)).toEqual([]);
    expect(await repo.search(alice, '"); DROP TABLE x; --', 5)).toEqual([]);
    expect(await repo.search(alice, '  ¿¡ !! ', 5)).toEqual([]);
  });

  it('reset deletes the whole thread', async () => {
    await exchange(alice, 1);
    await repo.trimWindow(alice, { maxMessages: 1, keepMessages: 1 });
    await repo.reset(alice);
    expect(await repo.loadActive(alice)).toEqual([]);
    expect(await repo.search(alice, 'question', 5)).toEqual([]);
    // A fresh thread starts over cleanly.
    await exchange(alice, 2);
    expect(await repo.loadActive(alice)).toHaveLength(2);
  });

  if (backend.name === 'sqlite') {
    it('prunes only archived messages older than the cutoff', async () => {
      await exchange(alice, 1, 100);
      await exchange(alice, 2, 100);
      await exchange(alice, 3, 5_000);
      await repo.trimWindow(alice, { maxMessages: 4, keepMessages: 2 }); // archives turns 1-2
      expect(await repo.pruneArchivedBefore(1_000)).toBe(4);
      expect(await repo.loadActive(alice)).toHaveLength(2);
      // Active messages are never pruned, however old.
      await exchange(bob, 1, 100);
      expect(await repo.pruneArchivedBefore(10_000)).toBe(0);
    });
  }
});
