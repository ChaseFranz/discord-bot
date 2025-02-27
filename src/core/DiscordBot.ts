import { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  Collection, 
  ClientOptions 
} from 'discord.js';
import OpenAI from 'openai';
import { Logger } from 'winston';
import ResetCommand from '../commands/reset.js';
import SummarizeMessageCommand from '../commands/summarizeMessage.js';
import SetLanguageCommand from '../commands/setLanguage.js';
import HelpCommand from '../commands/help.js';
import DescribeUserCommand from '../commands/describeUser.js';
import CustomizeCommand from '../commands/customize.js';
import ContextChatCommand from '../commands/contextChat.js';
import ChatCommand from '../commands/chat.js';
import ReadyEvent from '../events/ready.js';
import InteractionCreateEvent from '../events/interactionCreate.js';
import JoinVoiceChannelCommand from '../commands/joinVoiceChannel.js';
import LeaveVoiceChannelCommand from '../commands/leaveVoiceChannel.js';
import play from '../commands/music/play.js';
import skip from '../commands/music/skip.js';
import stop from '../commands/music/stop.js';
import LoggerService from '../services/Logger.js';

export interface HistoryEntry {
  role: string;
  content: string;
}

export interface UserSettings {
  temperature: number;
  style: string;
  [key: string]: any;
}

/**
 * DiscordBot class to manage the bot's functionality, including
 * command handling, event handling, and interaction with OpenAI.
 */
export class DiscordBot {
  public client: Client;
  public logger: Logger;
  public openai: OpenAI;
  public conversationHistories: Map<string, HistoryEntry[]>;
  public cooldowns: Map<string, Map<string, number>>;
  public userSettings: Map<string, UserSettings>;

  /**
   * Constructor to initialize the DiscordBot with necessary configurations.
   * @param {string} discordBotToken - The token for the Discord bot.
   * @param {string} clientId - The client ID of the Discord bot.
   * @param {string} guildId - The guild ID where the bot operates.
   * @param {string} openaiApiKey - The API key for OpenAI.
   * @param {string} openaiChatModel - The OpenAI model to use for chat interactions.
   * @param {string} openaiVoiceModel - The OpenAI model to use for voice interactions.
   * @param {ClientOptions} [clientOptions] - Optional client options for the Discord client.
   */
  constructor(
    private discordBotToken: string,
    private clientId: string,
    private guildId: string,
    private openaiApiKey: string,
    private openaiChatModel: string,
    private openaiVoiceModel: string,
    clientOptions?: ClientOptions,
  ) {

    this.logger = LoggerService.getInstance();

    // Initialize Discord client.
    this.client = new Client(
      clientOptions || {
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.GuildVoiceStates,
        ],
      }
    );

    // Initialize OpenAI.
    this.openai = new OpenAI({ apiKey: this.openaiApiKey });

    // Initialize maps.
    this.conversationHistories = new Map();
    this.cooldowns = new Map();
    this.userSettings = new Map();

    // Attach custom properties to the client.
    (this.client as any).conversationHistories = this.conversationHistories;
    (this.client as any).cooldowns = this.cooldowns;
    (this.client as any).userSettings = this.userSettings;
    this.client.openai = this.openai;
    (this.client as any).logger = this.logger;
    (this.client as any).commands = new Collection();
    (this.client as any).openaiChatModel = this.openaiChatModel;
    (this.client as any).openaiVoiceModel = this.openaiVoiceModel;
  }

  /**
   * Load commands explicitly.
   */
  public loadCommands(): void {
    const commandsArray: any[] = [];
    
    const commands = [
      ResetCommand,
      SummarizeMessageCommand,
      SetLanguageCommand,
      HelpCommand,
      DescribeUserCommand,
      CustomizeCommand,
      ContextChatCommand,
      ChatCommand,
      JoinVoiceChannelCommand,
      LeaveVoiceChannelCommand,
      play,
      skip,
      stop,
    ];

    for (const command of commands) {
      (this.client as any).commands.set(command.data.name, command);
      commandsArray.push(command.data);
    }
    this.logger.info(`Loaded ${commandsArray.length} commands.`);
    this.registerCommands(commandsArray);
  }

  /**
   * Register commands using guild-specific registration.
   * @param {any[]} commandsArray - Array of command data to register.
   */
  private async registerCommands(commandsArray: any[]): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(this.discordBotToken);
    try {
      this.logger.info(`Started refreshing ${commandsArray.length} application (/) commands.`);
      const response = await rest.put(Routes.applicationGuildCommands(this.clientId, this.guildId), {
        body: commandsArray,
      });
      this.logger.info('Successfully reloaded application (/) commands.');
      this.logger.info(`Discord API Response: ${JSON.stringify(response, null, 2)}`);
    } catch (error) {
      this.logger.error(`Error reloading commands: ${error}`);
    }
  }

  /**
   * Load event handlers explicitly.
   */
  public loadEvents(): void {
    const events = [
      ReadyEvent,
      InteractionCreateEvent
    ];

    for (const event of events) {
      if ('once' in event && event.once) {
        this.client.once(event.name, () => event.execute(this.client));
      } else {
        this.client.on(event.name, (...args: [any]) => event.execute(...args, this.client));
      }
    }
    
    this.logger.info(`Loaded ${events.length} events.`);
  }

  /**
   * Start the bot by logging in and setting up event listeners.
   */
  public start(): void {
    this.client.login(this.discordBotToken);
    this.client.on('ready', () => {
      this.logger.info(`Bot is online as ${this.client.user?.tag}`);
    });

    process.on('unhandledRejection', (error: any) => {
      this.logger.error(`Unhandled promise rejection: ${error}`);
    });
    process.on('uncaughtException', (error: any) => {
      this.logger.error(`Uncaught exception: ${error}`);
      process.exit(1);
    });
  }
}
