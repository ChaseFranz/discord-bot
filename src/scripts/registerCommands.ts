/**
 * Registers the slash commands in the bot's server. The bot on a PC does this itself at startup;
 * on AWS the deploy workflow runs this after each deploy.
 *
 *   npm run register-commands      (reads DISCORD_BOT_TOKEN, CLIENT_ID and GUILD_ID)
 *
 * With DISCORD_BOT_TOKEN_SECRET (a Secrets Manager secret name) instead of DISCORD_BOT_TOKEN, the
 * token is read from Secrets Manager, as the deploy workflow does.
 */
import dotenv from 'dotenv';
import { REST, Routes } from 'discord.js';
import { loadSecrets } from '../aws/settings.js';
import { describeError } from '../logging/logger.js';
import { allCommands } from '../runtime/core.js';

dotenv.config({ quiet: true });

async function main(): Promise<void> {
  await loadSecrets();
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  const clientId = process.env.CLIENT_ID?.trim();
  const guildId = process.env.GUILD_ID?.trim();
  if (!token || !clientId || !guildId) throw new Error('Set DISCORD_BOT_TOKEN, CLIENT_ID and GUILD_ID.');
  const body = allCommands().commands.map((command) => command.data.toJSON());
  await new REST({ version: '10' }).setToken(token).put(Routes.applicationGuildCommands(clientId, guildId), { body });
  process.stdout.write(`Registered ${body.length} slash commands in server ${guildId}.\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Registering commands failed: ${describeError(error)}\n`);
  process.exit(1);
});
