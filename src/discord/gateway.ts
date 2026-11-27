import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { describeError } from '../logging/logger.js';
import type { MusicService } from '../music/MusicService.js';
import type { CommandDispatcher } from './CommandDispatcher.js';
import { toApiBody, type CallInfo, type CommandContext, type ComponentContext, type VoiceChannelInfo } from './context.js';

/** Routes interactions that arrive over the Gateway (the bot running on a PC). */
export class GatewayInteractionRouter {
  constructor(
    private readonly dispatcher: CommandDispatcher,
    private readonly logger: { warn(message: string): unknown },
  ) {}

  async handle(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      await this.handleCommand(interaction);
    } else if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.inCachedGuild()) {
      await this.dispatcher.runComponent(componentContext(interaction));
    }
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const command = this.dispatcher.command(interaction.commandName);
    if (!command) return;
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
      return;
    }
    const waitSeconds = this.dispatcher.checkCooldown(command, interaction.user.id);
    if (waitSeconds !== undefined) {
      await interaction.reply({
        content: `Please wait ${waitSeconds.toFixed(1)} more second(s) before using \`${command.data.name}\` again.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    try {
      await interaction.deferReply(command.ephemeral ? { flags: MessageFlags.Ephemeral } : {});
    } catch (error) {
      this.logger.warn(`Could not defer /${interaction.commandName}: ${describeError(error)}`);
      return;
    }
    await this.dispatcher.runCommand(command, commandContext(interaction, command.ephemeral === true));
  }
}

function commandContext(interaction: ChatInputCommandInteraction<'cached'>, ephemeral: boolean): CommandContext {
  return {
    commandName: interaction.commandName,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    userTag: interaction.user.tag,
    displayName: interaction.member.displayName,
    channelId: interaction.channelId,
    channelName: interaction.channel?.name,
    string: (name) => interaction.options.getString(name),
    editReply: async (reply) => {
      await interaction.editReply(toApiBody(reply));
    },
    followUp: async (reply) => {
      await interaction.followUp({ ...toApiBody(reply), ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}) });
    },
  };
}

function componentContext(interaction: ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'>): ComponentContext {
  const select = interaction.isStringSelectMenu();
  return {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    userTag: interaction.user.tag,
    customId: interaction.customId,
    kind: select ? 'select' : 'button',
    values: select ? interaction.values : [],
    update: async (reply) => {
      await interaction.update(toApiBody(reply));
    },
    notify: async (message) => {
      const body = { content: message, flags: MessageFlags.Ephemeral } as const;
      if (interaction.replied || interaction.deferred) await interaction.followUp(body);
      else await interaction.reply(body);
    },
  };
}

/** Call state read from the Gateway's cache (voice states arrive with the GuildVoiceStates intent). */
export class GatewayCallInfo implements CallInfo {
  constructor(
    private readonly client: Client,
    private readonly music: Pick<MusicService, 'describe'> | undefined,
  ) {}

  async voiceChannelOf(guildId: string, userId: string): Promise<VoiceChannelInfo | undefined> {
    const channel = this.client.guilds.cache.get(guildId)?.voiceStates.cache.get(userId)?.channel;
    if (!channel) return undefined;
    return {
      id: channel.id,
      name: channel.name,
      people: [...channel.members.values()].filter((member) => !member.user.bot).map((member) => ({ id: member.id, name: member.displayName })),
    };
  }

  async musicStatus(guildId: string): Promise<string> {
    return this.music?.describe(guildId) ?? 'nothing playing';
  }
}
