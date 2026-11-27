import { describeError } from '../logging/logger.js';
import { MusicError } from '../music/types.js';
import type { CommandContext, ComponentContext } from './context.js';
import { unavailableReason, type AppServices, type BotCommand, type ComponentHandler } from './types.js';

const DEFAULT_COOLDOWN_SECONDS = 3;

/**
 * Runs commands and component handlers, whichever way the interaction arrived (Gateway or HTTPS):
 * per-user cooldowns, and uniform error replies so a failure never leaves "thinking…" hanging.
 */
export class CommandDispatcher {
  private readonly byName: Map<string, BotCommand>;
  private readonly cooldowns = new Map<string, Map<string, number>>();

  constructor(
    readonly commands: readonly BotCommand[],
    private readonly components: readonly ComponentHandler[],
    private readonly services: AppServices,
  ) {
    this.byName = new Map(commands.map((command) => [command.data.name, command]));
  }

  command(name: string): BotCommand | undefined {
    return this.byName.get(name);
  }

  /** Returns seconds left if the user is still cooling down; otherwise starts a new cooldown. */
  checkCooldown(command: BotCommand, userId: string, now = Date.now()): number | undefined {
    const cooldownMs = (command.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS) * 1000;
    let timestamps = this.cooldowns.get(command.data.name);
    if (!timestamps) {
      timestamps = new Map();
      this.cooldowns.set(command.data.name, timestamps);
    }
    const last = timestamps.get(userId);
    if (last !== undefined && now < last + cooldownMs) return (last + cooldownMs - now) / 1000;
    timestamps.set(userId, now);
    setTimeout(() => timestamps.delete(userId), cooldownMs).unref();
    return undefined;
  }

  /** Why `command` can't be used right now (its feature is turned off), or undefined if it can. */
  unavailable(command: BotCommand): string | undefined {
    return unavailableReason(command, this.services.config);
  }

  /** Runs an already-deferred command, replying with an error message if it fails. */
  async runCommand(command: BotCommand, context: CommandContext): Promise<void> {
    const reason = this.unavailable(command);
    if (reason) {
      await context.editReply(reason).catch((error: unknown) => this.services.logger.warn(`Could not send reply: ${describeError(error)}`));
      return;
    }
    try {
      await command.execute(context, this.services);
    } catch (error) {
      const message = error instanceof MusicError ? error.message : 'There was an error executing that command.';
      if (!(error instanceof MusicError)) {
        this.services.logger.error(`Error executing /${context.commandName}: ${describeError(error)}`);
      }
      try {
        await context.editReply({ content: message, embeds: [], components: [] });
      } catch (replyError) {
        this.services.logger.warn(`Could not send error reply: ${describeError(replyError)}`);
      }
    }
  }

  async runComponent(context: ComponentContext): Promise<void> {
    const prefix = context.customId.split(':', 1)[0];
    const handler = this.components.find((candidate) => candidate.prefix === prefix);
    if (!handler) return;
    try {
      await handler.execute(context, this.services);
    } catch (error) {
      this.services.logger.error(`Error handling component ${context.customId}: ${describeError(error)}`);
      await context.notify('Something went wrong.').catch(() => undefined);
    }
  }
}
