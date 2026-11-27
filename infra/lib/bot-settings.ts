/**
 * Parses extra bot settings for the deployed bot: the names in .env.example, written as
 * `NAME=value` pairs separated by commas, semicolons or new lines, e.g.
 * `VOICE_SILENCE_MS=500, VOICE_BARGE_IN=everyone`. They come from the BOT_SETTINGS variable of the
 * GitHub environment, which anyone who can read the repository's settings and logs can see, so a
 * name that looks like a secret is refused: secrets belong in Secrets Manager.
 */
export function parseBotSettings(text: string | undefined): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const pair of (text ?? '').split(/[\n,;]+/)) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const match = /^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) throw new Error(`botSettings: "${trimmed}" is not written as NAME=value`);
    const [, name, value] = match as unknown as [string, string, string];
    if (/TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY/.test(name)) {
      throw new Error(`botSettings: ${name} looks like a secret. Secrets belong in Secrets Manager, not in settings.`);
    }
    settings[name] = value.trim();
  }
  return settings;
}
