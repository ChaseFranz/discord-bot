/**
 * Slash commands whose replies only the person who used them can see. Kept here, apart from the
 * commands themselves, so the Lambda that answers Discord within 3 seconds doesn't load discord.js
 * just to know whether its "thinking…" should be ephemeral. A test checks it matches the commands.
 */
export const EPHEMERAL_COMMANDS: ReadonlySet<string> = new Set(['memories', 'privacy', 'usage']);
