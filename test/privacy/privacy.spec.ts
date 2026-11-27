import { PrivacyService } from '../../src/privacy/PrivacyService.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/sqlite/database.js';
import { SqliteSettingsRepository } from '../../src/storage/sqlite/SqliteSettingsRepository.js';

describe('privacy settings', () => {
  let db: SqliteDatabase;
  let settings: SqliteSettingsRepository;
  beforeEach(() => {
    db = openDatabase(':memory:');
    settings = new SqliteSettingsRepository(db);
  });
  afterEach(() => db.close());

  it('defaults to full, caches, and tells listeners about changes', async () => {
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

  it('rejects unknown levels at the database', () => {
    expect(() =>
      db.prepare("INSERT INTO user_settings (guild_id, user_id, style, privacy, updated_at) VALUES ('g', 'x', 'default', 'loud', 0)").run(),
    ).toThrow();
  });
});
