import { CommandDispatcher } from './discord/CommandDispatcher.js';
import { DiscordBot } from './discord/DiscordBot.js';
import { GatewayCallInfo, GatewayInteractionRouter } from './discord/gateway.js';
import { MentionChat } from './discord/MentionChat.js';
import type { AppServices } from './discord/types.js';
import type { AppConfig } from './config/config.js';
import { describeError, type Logger } from './logging/logger.js';
import { schedulerAlarm } from './reminders/alarm.js';
import { createReminderDelivery } from './reminders/ReminderDelivery.js';
import { ReminderScheduler } from './reminders/ReminderScheduler.js';
import { buildCallStack } from './runtime/callStack.js';
import { allCommands, openCore } from './runtime/core.js';
import { systemSchedule } from './util/schedule.js';
import { systemClock, type Clock } from './util/time.js';

export { buildRoutes } from './runtime/core.js';

export interface RunningApp {
  stop(): Promise<void>;
}

const RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000;
/** On startup, recap calls from the last day that ended without one. */
const RECAP_CATCH_UP_MS = 24 * 60 * 60 * 1000;

/** The whole bot in one process, as it runs on a PC: Gateway connection, voice, reminders, everything. */
export async function startApp(config: AppConfig, logger: Logger, clock: Clock = systemClock): Promise<RunningApp> {
  const core = await openCore(config, logger, clock);
  const { storage, usage } = core;
  const closedSessions = await storage.transcripts.endOpenSessions(clock());
  if (closedSessions > 0) logger.info(`Closed ${closedSessions} voice session(s) left open by the last run.`);

  const sweepRetention = async () => {
    const days = config.storage.retentionDays;
    // DynamoDB deletes expired items itself (TTL).
    if (days <= 0 || storage.expiresOnItsOwn) return;
    const cutoff = clock() - days * 24 * 60 * 60 * 1000;
    const segments = await storage.transcripts.pruneBefore(cutoff);
    const messages = await storage.conversations.pruneArchivedBefore(cutoff);
    const finished = await storage.reminders.pruneFinishedBefore(cutoff);
    if (segments + messages + finished > 0) {
      logger.info(`Retention: deleted ${segments} transcript line(s), ${messages} archived message(s) and ${finished} old reminder(s).`);
    }
  };
  await sweepRetention();
  const retentionTimer = setInterval(() => {
    sweepRetention().catch((error: unknown) => logger.warn(`Retention sweep failed: ${describeError(error)}`));
  }, RETENTION_SWEEP_MS);
  retentionTimer.unref();

  const today = usage.status(config.discord.guildId);
  logger.info(
    today.budgetUsd === null
      ? `Spent so far today: $${today.spentUsd.toFixed(2)} (no daily cap).`
      : `Spent so far today: $${today.spentUsd.toFixed(2)} of the $${today.budgetUsd.toFixed(2)} daily budget.`,
  );

  const bot = new DiscordBot({ token: config.discord.token, clientId: config.discord.clientId, guildId: config.discord.guildId, logger });
  let scheduler: ReminderScheduler | undefined;
  const call = await buildCallStack(core, bot, schedulerAlarm(() => scheduler));
  scheduler = new ReminderScheduler({
    reminders: storage.reminders,
    deliver: createReminderDelivery({
      voice: {
        callMembers: (guild) => call.voice.get(guild)?.presentMembers(),
        announce: (guild, text) => call.conversation.announce(guild, text),
      },
      messenger: bot,
      logger,
    }),
    clock,
    schedule: systemSchedule,
    logger,
  });

  const { commands, components } = allCommands();
  const services: AppServices = {
    config,
    logger,
    assistant: call.assistant,
    conversations: storage.conversations,
    settings: storage.settings,
    memories: storage.memories,
    privacy: core.privacy,
    usage,
    calls: new GatewayCallInfo(bot.client, call.music),
    voice: call.voice,
    music: call.music,
    commands: () => commands,
    mentionChat: true,
  };
  const router = new GatewayInteractionRouter(new CommandDispatcher(commands, components, services), logger);
  const mentions = new MentionChat(services, { guildId: config.discord.guildId, botUserId: () => bot.userId });
  await bot.registerCommands(commands);
  await bot.start({ interactions: router, messages: mentions.handle, voiceStates: (change) => call.voice.voiceStateChanged(change) });
  try {
    const endpoint = await bot.interactionsEndpointUrl();
    if (endpoint) {
      logger.warn(`Slash commands are being sent to ${endpoint}, not to this copy of the bot. Run "npm run aws:off" to use it here.`);
    }
  } catch (error) {
    logger.debug(`Could not check where slash commands go: ${describeError(error)}`);
  }

  // Needs Discord to be connected: reminders that came due while the bot was off go out now.
  scheduler.start();
  call.recapper.catchUp(clock() - RECAP_CATCH_UP_MS).catch((error: unknown) => logger.warn(`Recap catch-up failed: ${describeError(error)}`));

  let stopping: Promise<void> | undefined;
  return {
    stop() {
      stopping ??= (async () => {
        clearInterval(retentionTimer);
        scheduler?.stop();
        // Recaps of calls cut short by the shutdown are written on the next start.
        await call.recapper.stop();
        await call.voice.leaveAll();
        await scheduler?.idle();
        await bot.stop();
        await core.close();
        logger.info('Shut down cleanly.');
      })();
      return stopping;
    },
  };
}
