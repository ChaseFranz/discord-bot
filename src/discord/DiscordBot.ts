import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  type Message,
  type VoiceBasedChannel,
  type VoiceState,
} from 'discord.js';
import type { Logger } from '../logging/logger.js';
import { describeError } from '../logging/logger.js';
import type { ReminderMessenger } from '../reminders/ReminderDelivery.js';
import type { VoiceStateChange } from '../voice/VoiceSessionManager.js';
import type { GatewayInteractionRouter } from './gateway.js';
import type { BotCommand } from './types.js';

export interface DiscordBotOptions {
  token: string;
  clientId: string;
  guildId: string;
  logger: Logger;
  /** Default: guilds, voice states and guild messages (for @mention chat). */
  intents?: GatewayIntentBits[];
}

export interface DiscordHandlers {
  /** Slash commands over the Gateway (not used when they're delivered to Lambda instead). */
  interactions?: GatewayInteractionRouter;
  /** Every message the bot can see (it only gets the content of ones that mention it). */
  messages?: (message: Message) => Promise<void>;
  voiceStates: (change: VoiceStateChange) => void;
}

/** The Discord client: login, slash-command registration, event wiring, and posting messages. */
export class DiscordBot implements ReminderMessenger {
  readonly client: Client;

  constructor(private readonly options: DiscordBotOptions) {
    // No privileged intents: message content arrives only for messages that mention the bot.
    this.client = new Client({
      intents: options.intents ?? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
    });
  }

  /** Registers the commands in the configured guild (updates instantly, unlike global commands). */
  async registerCommands(commands: readonly BotCommand[]): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(this.options.token);
    const body = commands.map((command) => command.data.toJSON());
    await rest.put(Routes.applicationGuildCommands(this.options.clientId, this.options.guildId), { body });
    this.options.logger.info(`Registered ${body.length} slash commands in guild ${this.options.guildId}.`);
  }

  /** Logs in and resolves once the client is ready. */
  async start(handlers: DiscordHandlers): Promise<void> {
    const { logger } = this.options;
    const { interactions, messages } = handlers;
    if (interactions) {
      this.client.on(Events.InteractionCreate, (interaction) => {
        interactions.handle(interaction).catch((error: unknown) => logger.error(`Unhandled interaction error: ${describeError(error)}`));
      });
    }
    if (messages) {
      this.client.on(Events.MessageCreate, (message) => {
        messages(message).catch((error: unknown) => logger.error(`Unhandled message error: ${describeError(error)}`));
      });
    }
    this.client.on(Events.VoiceStateUpdate, (oldState: VoiceState, newState: VoiceState) => {
      try {
        handlers.voiceStates({
          guildId: newState.guild.id,
          userId: newState.id,
          oldChannelId: oldState.channelId,
          newChannelId: newState.channelId,
          newChannel: newState.channel,
        });
      } catch (error) {
        logger.error(`Voice state handler failed: ${describeError(error)}`);
      }
    });
    this.client.on(Events.Error, (error) => logger.error(`Discord client error: ${describeError(error)}`));
    this.client.on(Events.Warn, (message) => logger.warn(`Discord: ${message}`));

    const ready = new Promise<void>((resolve) => {
      this.client.once(Events.ClientReady, (client) => {
        client.user.setActivity('chatting with humans', { type: ActivityType.Playing });
        logger.info(`Bot is online as ${client.user.tag}`);
        resolve();
      });
    });
    await this.client.login(this.options.token);
    await ready;
  }

  /**
   * Where Discord sends slash commands: an HTTPS URL (Lambda, on AWS), or undefined for the Gateway.
   * Discord delivers interactions one way or the other, never both.
   */
  async interactionsEndpointUrl(): Promise<string | undefined> {
    const rest = new REST({ version: '10' }).setToken(this.options.token);
    const app = (await rest.get(Routes.currentApplication())) as { interactions_endpoint_url?: string | null };
    return app.interactions_endpoint_url || undefined;
  }

  get userId(): string {
    return this.client.user?.id ?? 'assistant';
  }

  async resolveVoiceChannel(guildId: string, channelId: string): Promise<VoiceBasedChannel | null> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isVoiceBased() || channel.guild.id !== guildId) return null;
    return channel;
  }

  async postInChannel(guildId: string, channelId: string, content: string, mentionUserId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.isDMBased() || channel.guildId !== guildId) throw new Error('channel not found in this server');
    if (!channel.isSendable()) throw new Error("can't send messages there");
    await channel.send({ content, allowedMentions: { users: [mentionUserId] } });
  }

  async sendDirect(userId: string, content: string): Promise<void> {
    await this.client.users.send(userId, { content, allowedMentions: { parse: [] } });
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }
}
