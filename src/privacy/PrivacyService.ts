import type { PrivacyLevel, SettingsRepository } from '../storage/ports.js';

export type PrivacyListener = (guildId: string, userId: string, level: PrivacyLevel) => void;

/**
 * Each person's transcription choice (see PrivacyLevel).
 *
 * It is read from storage every time it's asked for and never remembered here. The bot can run as
 * several processes (on AWS, /privacy is handled by one and calls are run by another), and a
 * choice made in one has to hold in the others straight away. Remembering it would mean listening
 * to someone who has just said not to.
 */
export class PrivacyService {
  private readonly listeners: PrivacyListener[] = [];

  constructor(private readonly settings: SettingsRepository) {}

  async level(guildId: string, userId: string): Promise<PrivacyLevel> {
    return (await this.settings.get({ guildId, userId }))?.privacy ?? 'full';
  }

  async set(guildId: string, userId: string, level: PrivacyLevel): Promise<void> {
    await this.settings.update({ guildId, userId }, { privacy: level });
    for (const listener of this.listeners) listener(guildId, userId, level);
  }

  /**
   * Called after someone changes their level through this process. A change made through another
   * process is not announced here: whoever needs to act on one has to ask `level` again.
   */
  onChange(listener: PrivacyListener): void {
    this.listeners.push(listener);
  }
}
