import { Client, GatewayIntentBits, REST, Routes, Collection } from 'discord.js';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import config from './config.js';
import winston from 'winston';
import { fileURLToPath } from 'url';

// Set up __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
  ),
  transports: [new winston.transports.Console()],
});

// Destructure configuration values
const { openaiApiKey, discordBotToken, clientId, guildId } = config;

// Initialize the Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Initialize OpenAI
const openai = new OpenAI({ apiKey: openaiApiKey });

// Create maps for conversation histories, cooldowns, and user settings.
const conversationHistories = new Map();
const cooldowns = new Map();
const userSettings = new Map();

// Attach these objects to the client so event modules can access them.
client.conversationHistories = conversationHistories;
client.cooldowns = cooldowns;
client.userSettings = userSettings;
client.openai = openai;
client.logger = logger;

// Load commands dynamically.
client.commands = new Collection();
const commandsArray = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = await import(`file://${filePath}`);
  client.commands.set(command.default.data.name, command.default);
  // For commands built with a builder, convert to JSON if available.
  commandsArray.push(typeof command.default.data.toJSON === 'function' ? command.default.data.toJSON() : command.default.data);
}

// Register slash commands with Discord (using guild-specific registration for fast updates)
const rest = new REST({ version: '10' }).setToken(discordBotToken);
(async () => {
  try {
    logger.info('Started refreshing application (/) commands.');
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandsArray });
    logger.info('Successfully reloaded application (/) commands.');
  } catch (error) {
    logger.error(`Error reloading commands: ${error}`);
  }
})();

// Load event handlers from the "events" folder.
const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
  const filePath = path.join(eventsPath, file);
  const event = await import(`file://${filePath}`);
  if (event.default.once) {
    client.once(event.default.name, (...args) => event.default.execute(...args, client));
  } else {
    client.on(event.default.name, (...args) => event.default.execute(...args, client));
  }
}

// Global error handling
process.on('unhandledRejection', (error) => {
  logger.error(`Unhandled promise rejection: ${error}`);
});
process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error}`);
  process.exit(1);
});

client.login(discordBotToken);
