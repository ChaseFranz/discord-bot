import { PrivacyService } from '../../src/privacy/PrivacyService.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/sqlite/database.js';
import { SqliteSettingsRepository } from '../../src/storage/sqlite/SqliteSettingsRepository.js';
import { fakeClock } from '../helpers.js';
import { backends, type TestStorage } from '../storage/backends.js';

describe('privacy settings', () => {
  let db: SqliteDatabase;
  let settings: SqliteSettingsRepository;
  beforeEach(() => {
    db = openDatabase(':memory:');
    settings = new SqliteSettingsRepository(db);
  });
  afterEach(() => db.close());

  it('defaults to full, keeps a choice, and tells listeners about changes', async () => {
    const privacy = new PrivacyService(settings);
    const changes: string[] = [];
    privacy.onChange((guildId, userId, level) => changes.push(`${guildId}/${userId}=${level}`));
    expect(await privacy.level('g', 'u')).toBe('full');
    await privacy.set('g', 'u', 'requests');
    expect(await privacy.level('g', 'u')).toBe('requests');
    expect(await new PrivacyService(settings).level('g', 'u')).toBe('requests'); // persisted
    expect(await privacy.level('other', 'u')).toBe('full');
    expect(changes).toEqual(['g/u=requests']);
  });

  it('asks the settings every time, so nothing it once knew can be out of date', async () => {
    let reads = 0;
    const counting = { get: (scope: Parameters<typeof settings.get>[0]) => (reads++, settings.get(scope)), update: settings.update.bind(settings) };
    const privacy = new PrivacyService(counting);
    await privacy.level('g', 'u');
    await privacy.level('g', 'u');
    expect(reads).toBe(2);
  });

  it('rejects unknown levels at the database', () => {
    expect(() =>
      db.prepare("INSERT INTO user_settings (guild_id, user_id, style, privacy, updated_at) VALUES ('g', 'x', 'default', 'loud', 0)").run(),
    ).toThrow();
  });
});

/**
 * On AWS, /privacy is handled by one process (a Lambda) and calls are run by another (the voice
 * task), each with its own PrivacyService over the same storage.
 */
describe.each(backends)('a privacy choice made in another process ($name)', ({ open }) => {
  const GUILD = '1083158655429509190';
  const ALICE = '100000000000000001';
  let storage: TestStorage;
  beforeEach(async () => {
    storage = await open(fakeClock());
  });
  afterEach(() => storage.close());

  it('holds at once in a process that had already looked', async () => {
    const commands = new PrivacyService(storage.settings);
    const call = new PrivacyService(storage.settings);
    // The call has already listened to them once.
    expect(await call.level(GUILD, ALICE)).toBe('full');

    await commands.set(GUILD, ALICE, 'off');
    expect(await call.level(GUILD, ALICE)).toBe('off');
    await commands.set(GUILD, ALICE, 'requests');
    expect(await call.level(GUILD, ALICE)).toBe('requests');
    await commands.set(GUILD, ALICE, 'full');
    expect(await call.level(GUILD, ALICE)).toBe('full');
  });
});
