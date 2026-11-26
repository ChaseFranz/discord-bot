import { MessageFlags, type ChatInputCommandInteraction, type Interaction } from 'discord.js';
import { describeError } from '../logging/logger.js';
import { MusicError } from '../music/types.js';
import type { AppServices, BotCommand, ComponentHandler, ComponentInteraction } from './types.js';

const DEFAULT_COOLDOWN_SECONDS = 3;

/** Routes interactions to commands and component (button/select menu) handlers, with per-user cooldowns and uniform error replies. */
export class InteractionRouter {
  private readonly commands: Map<string, BotCommand>;
  private readonly cooldowns = new Map<string, Map<string, number>>();

  constructor(
    commands: readonly BotCommand[],
    private readonly components: readonly ComponentHandler[],
    private readonly services: AppServices,
  ) {
    this.commands = new Map(commands.map((command) => [command.data.name, command]));
  }

  async handle(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      await this.handleCommand(interaction);
    } else if (interaction.isButton()) {
      if (interaction.inCachedGuild()) await this.handleComponent(interaction);
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.inCachedGuild()) await this.handleComponent(interaction);
    }
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const command = this.commands.get(interaction.commandName);
    if (!command) return;
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
      return;
    }

    const waitSeconds = this.checkCooldown(command, interaction.user.id);
    if (waitSeconds !== undefined) {
      await interaction.reply({
        content: `Please wait ${waitSeconds.toFixed(1)} more second(s) before using \`${command.data.name}\` again.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      await interaction.deferReply(command.ephemeral ? { flags: MessageFlags.Ephemeral } : {});
      await command.execute(interaction, this.services);
    } catch (error) {
      const message =
        error instanceof MusicError ? error.message : 'There was an error executing that command.';
      if (!(error instanceof MusicError)) {
        this.services.logger.error(`Error executing /${interaction.commandName}: ${describeError(error)}`);
      }
      await this.replyWithError(interaction, message);
    }
  }

  private async handleComponent(interaction: ComponentInteraction): Promise<void> {
    const prefix = interaction.customId.split(':', 1)[0];
    const handler = this.components.find((candidate) => candidate.prefix === prefix);
    if (!handler) return;
    try {
      await handler.execute(interaction, this.services);
    } catch (error) {
      this.services.logger.error(`Error handling component ${interaction.customId}: ${describeError(error)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      }
    }
  }

  /** Returns seconds left if the user is still cooling down; otherwise starts a new cooldown. */
  private checkCooldown(command: BotCommand, userId: string): number | undefined {
    const now = Date.now();
    const cooldownMs = (command.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS) * 1000;
    let timestamps = this.cooldowns.get(command.data.name);
    if (!timestamps) {
      timestamps = new Map();
      this.cooldowns.set(command.data.name, timestamps);
    }
    const last = timestamps.get(userId);
    if (last !== undefined && now < last + cooldownMs) {
      return (last + cooldownMs - now) / 1000;
    }
    timestamps.set(userId, now);
    setTimeout(() => timestamps.delete(userId), cooldownMs).unref();
    return undefined;
  }

  private async replyWithError(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content, embeds: [], components: [] });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      this.services.logger.warn(`Could not send error reply: ${describeError(error)}`);
    }
  }
}
