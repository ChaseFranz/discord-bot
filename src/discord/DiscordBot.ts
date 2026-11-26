import { ActivityType, Client, Events, GatewayIntentBits, REST, Routes, type VoiceBasedChannel } from 'discord.js';
import type { Logger } from '../logging/logger.js';
import { describeError } from '../logging/logger.js';
import type { InteractionRouter } from './InteractionRouter.js';
import type { BotCommand } from './types.js';

export interface DiscordBotOptions {
  token: string;
  clientId: string;
  guildId: string;
  logger: Logger;
}

/** The Discord client: login, slash-command registration, and event wiring. */
export class DiscordBot {
  readonly client: Client;

  constructor(private readonly options: DiscordBotOptions) {
    // Slash commands and voice only: no message-content (privileged) intent needed.
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  }

  /** Registers the commands in the configured guild (updates instantly, unlike global commands). */
  async registerCommands(commands: readonly BotCommand[]): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(this.options.token);
    const body = commands.map((command) => command.data.toJSON());
    await rest.put(Routes.applicationGuildCommands(this.options.clientId, this.options.guildId), { body });
    this.options.logger.info(`Registered ${body.length} slash commands in guild ${this.options.guildId}.`);
  }

  /** Logs in and resolves once the client is ready. */
  async start(router: InteractionRouter): Promise<void> {
    const { logger } = this.options;
    this.client.on(Events.InteractionCreate, (interaction) => {
      router.handle(interaction).catch((error: unknown) => logger.error(`Unhandled interaction error: ${describeError(error)}`));
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

  get userId(): string {
    return this.client.user?.id ?? 'assistant';
  }

  async resolveVoiceChannel(guildId: string, channelId: string): Promise<VoiceBasedChannel | null> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isVoiceBased() || channel.guild.id !== guildId) return null;
    return channel;
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }
}
