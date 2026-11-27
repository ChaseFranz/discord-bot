import type { APIInteraction } from 'discord-api-types/v10';
import type { VoiceTaskControl } from '../calls/voiceTask.js';
import type { CommandDispatcher } from '../discord/CommandDispatcher.js';
import { httpCommandContext, httpComponentContext, isChatInputGuildCommand, isGuildComponent, type DiscordRestApi } from '../discord/http.js';
import type { Logger } from '../logging/logger.js';
import { describeError } from '../logging/logger.js';
import type { UsageService } from '../usage/UsageService.js';

export interface InteractionWorkerDeps {
  /** The one server the bot serves (where its commands are registered). */
  guildId: string;
  applicationId: string;
  rest: DiscordRestApi;
  dispatcher: CommandDispatcher;
  control: Pick<VoiceTaskControl, 'dispatch'>;
  usage: Pick<UsageService, 'refresh' | 'flush'>;
  logger: Logger;
}

/**
 * Runs one interaction the edge has already answered with "thinking…": text commands and buttons
 * right here, voice commands by handing them to the voice task (starting it for /join and /play).
 */
export class InteractionWorker {
  constructor(private readonly deps: InteractionWorkerDeps) {}

  async handle(interaction: APIInteraction): Promise<void> {
    try {
      if (isChatInputGuildCommand(interaction)) await this.command(interaction);
      else if (isGuildComponent(interaction)) await this.component(interaction);
    } finally {
      // Lambda freezes once the handler returns, so spending is saved before that.
      await this.deps.usage.flush();
    }
  }

  private async command(interaction: Parameters<typeof httpCommandContext>[0]): Promise<void> {
    const { deps } = this;
    const command = deps.dispatcher.command(interaction.data.name);
    const context = httpCommandContext(interaction, { rest: deps.rest, applicationId: deps.applicationId, ephemeral: command?.ephemeral === true });
    if (!command) {
      await context.editReply('That command no longer exists.');
      return;
    }
    if (interaction.guild_id !== deps.guildId) {
      await context.editReply('This bot only works in its own server.');
      return;
    }
    // Another process (the voice task, another Lambda) may have spent since this one last looked.
    await deps.usage.refresh(interaction.guild_id);
    const waitSeconds = deps.dispatcher.checkCooldown(command, context.userId);
    if (waitSeconds !== undefined) {
      await context.editReply(`Please wait ${waitSeconds.toFixed(1)} more second(s) before using \`${command.data.name}\` again.`);
      return;
    }
    if (!command.voice) {
      await deps.dispatcher.runCommand(command, context);
      return;
    }
    try {
      await deps.control.dispatch(command, interaction, context);
    } catch (error) {
      deps.logger.error(`Could not pass /${command.data.name} to the voice task: ${describeError(error)}`);
      await context.editReply('Something went wrong reaching the voice channel side of me. Please try again.').catch(() => undefined);
    }
  }

  private async component(interaction: Parameters<typeof httpComponentContext>[0]): Promise<void> {
    if (interaction.guild_id !== this.deps.guildId) return;
    await this.deps.usage.refresh(interaction.guild_id);
    await this.deps.dispatcher.runComponent(httpComponentContext(interaction, { rest: this.deps.rest, applicationId: this.deps.applicationId }));
  }
}
