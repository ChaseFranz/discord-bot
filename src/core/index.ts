import 'dotenv/config';
import { DiscordBot } from './DiscordBot.js';
import { config } from '../config/config.js';

const bot = new DiscordBot(config.discordBotToken, config.clientId, config.guildId, config.openaiApiKey);

(async () => {
  bot.loadCommands();
  bot.loadEvents();
  bot.start();
})();
