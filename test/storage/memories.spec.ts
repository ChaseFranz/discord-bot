import { openMemoryDatabase, type SqliteDatabase } from '../../src/storage/sqlite/database.js';
import { SqliteMemoryRepository } from '../../src/storage/sqlite/SqliteMemoryRepository.js';

describe('SqliteMemoryRepository', () => {
  let db: SqliteDatabase;
  let repo: SqliteMemoryRepository;

  beforeEach(() => {
    db = openMemoryDatabase(':memory:');
    repo = new SqliteMemoryRepository(db);
  });
  afterEach(() => db.close());

  const add = (subjectId: string | null, text: string, createdAt = 1_000, guildId = 'g') =>
    repo.add({ guildId, subjectId, subjectName: subjectId ?? 'the server', text, sourceUserId: 'src', sourceName: 'Src', createdAt });

  it('lists notes per subject, newest first, capped per subject, scoped to the guild', async () => {
    await add('a', 'old', 1);
    await add('a', 'new', 3);
    await add('a', 'middle', 2);
    await add(null, 'server note');
    await add('b', 'other person');
    await add('a', 'elsewhere', 9, 'other-guild');

    const notes = await repo.listAbout('g', ['a', null, 'a'], 2);
    expect(notes.map((n) => n.text)).toEqual(['new', 'middle', 'server note']);
    expect(await repo.countAbout('g', 'a')).toBe(3);
    expect(await repo.countAbout('g', null)).toBe(1);
  });

  it('updates, deletes, and forgets everything about one person', async () => {
    const note = await add('a', 'Likes tea');
    expect((await repo.update('g', note.id, 'Likes coffee', 5))?.text).toBe('Likes coffee');
    expect((await repo.update('other-guild', note.id, 'nope', 6))).toBeUndefined();
    await add('a', 'Second');
    await add('b', 'Keep me');
    expect(await repo.deleteAllAbout('g', 'a')).toBe(2);
    expect((await repo.listAbout('g', ['b'], 5)).map((n) => n.text)).toEqual(['Keep me']);
    expect(await repo.delete('g', note.id)).toBe(false);
  });

  it('full-text searches notes with stemming', async () => {
    await add('a', 'Plays the guitar in a band');
    await add('b', 'Favourite game is Hades');
    expect((await repo.search('g', 'playing guitars', 5)).map((n) => n.text)).toEqual(['Plays the guitar in a band']);
    expect(await repo.search('other-guild', 'guitar', 5)).toEqual([]);
    expect(await repo.search('g', '"(', 5)).toEqual([]);
  });
});
