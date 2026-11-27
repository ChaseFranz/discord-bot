import type { PrivacyLevel, SettingsRepository } from '../storage/ports.js';

export type PrivacyListener = (guildId: string, userId: string, level: PrivacyLevel) => void;

/**
 * Each person's transcription choice (see PrivacyLevel), cached in memory because it's checked
 * every time someone starts talking in a call.
 */
export class PrivacyService {
  private readonly cache = new Map<string, PrivacyLevel>();
  private readonly listeners: PrivacyListener[] = [];

  constructor(private readonly settings: SettingsRepository) {}

  async level(guildId: string, userId: string): Promise<PrivacyLevel> {
    const key = cacheKey(guildId, userId);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const level = (await this.settings.get({ guildId, userId }))?.privacy ?? 'full';
    this.cache.set(key, level);
    return level;
  }

  async set(guildId: string, userId: string, level: PrivacyLevel): Promise<void> {
    await this.settings.update({ guildId, userId }, { privacy: level });
    this.cache.set(cacheKey(guildId, userId), level);
    for (const listener of this.listeners) listener(guildId, userId, level);
  }

  /** Called after someone changes their level. */
  onChange(listener: PrivacyListener): void {
    this.listeners.push(listener);
  }
}

function cacheKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}
