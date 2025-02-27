import 'dotenv/config';
import { DiscordBot } from './core/DiscordBot.js';
import { config } from './config/config.js';

const bot = new DiscordBot(config.discordBotToken, config.clientId, config.guildId, config.openaiApiKey, config.openaiChatModel, config.openaiVoiceModel);

(async () => {
  bot.loadCommands();
  bot.loadEvents();
  bot.start();
})();
