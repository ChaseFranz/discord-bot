import { GatewayIntentBits } from 'discord.js';
import { VoiceTaskRunner, type CallSnapshot } from '../calls/voiceTask.js';
import { ConfigError, loadConfig } from '../config/config.js';
import { CommandDispatcher } from '../discord/CommandDispatcher.js';
import { DiscordBot } from '../discord/DiscordBot.js';
import { GatewayCallInfo } from '../discord/gateway.js';
import { createDiscordRest, httpCommandContext } from '../discord/http.js';
import type { AppServices } from '../discord/types.js';
import { createLogger, describeError } from '../logging/logger.js';
import { buildCallStack } from '../runtime/callStack.js';
import { allCommands, openCore } from '../runtime/core.js';
import { systemClock } from '../util/time.js';
import { musicRelay, reminderAlarm, voiceTaskPlumbing } from './plumbing.js';
import { loadAwsSettings, loadSecrets } from './settings.js';

/**
 * The voice task: a Fargate container started by /join or /play. It connects to Discord, takes
 * its orders (relayed slash commands, reminder announcements) from the queue, handles the call
 * exactly as the bot on a PC would, and exits once it has been out of a call for a couple of
 * minutes. Slash commands reach Lambda, not this process, so it never registers or receives them.
 */
const RECAP_CATCH_UP_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  await loadSecrets();
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const settings = loadAwsSettings([
    'VOICE_QUEUE_URL',
    'VOICE_TASK_IDLE_EXIT_SECONDS',
    'REMINDER_FUNCTION_ARN',
    'REMINDER_SCHEDULE_GROUP',
    'REMINDER_SCHEDULER_ROLE_ARN',
  ]);
  const clock = systemClock;
  const guildId = config.discord.guildId;

  const core = await openCore(config, logger, clock, { verifyClaude: false });
  const closed = await core.storage.transcripts.endOpenSessions(clock());
  if (closed > 0) logger.info(`Closed ${closed} voice session(s) left open by the last voice task.`);

  // No message intent: @mention chat isn't offered on AWS.
  const bot = new DiscordBot({
    token: config.discord.token,
    clientId: config.discord.clientId,
    guildId,
    logger,
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  const relay = musicRelay(config, clock);
  const call = await buildCallStack(core, bot, reminderAlarm(settings, clock), relay);
  const { store, queue } = voiceTaskPlumbing(config, settings, clock);
  const { commands, components } = allCommands();
  const services: AppServices = {
    config,
    logger,
    assistant: call.assistant,
    conversations: core.storage.conversations,
    settings: core.storage.settings,
    memories: core.storage.memories,
    privacy: core.privacy,
    usage: core.usage,
    calls: new GatewayCallInfo(bot.client, call.music),
    voice: call.voice,
    music: call.music,
    musicHelpers: relay?.desk,
    commands: () => commands,
    mentionChat: false,
  };
  const dispatcher = new CommandDispatcher(commands, components, services);
  const rest = createDiscordRest(config.discord.token);

  await bot.start({ voiceStates: (change) => call.voice.voiceStateChanged(change) });
  call.recapper.catchUp(clock() - RECAP_CATCH_UP_MS).catch((error: unknown) => logger.warn(`Recap catch-up failed: ${describeError(error)}`));

  const runner = new VoiceTaskRunner({
    guildId,
    store,
    queue,
    runInteraction: async (interaction) => {
      const command = dispatcher.command(interaction.data.name);
      if (!command) return;
      await dispatcher.runCommand(
        command,
        httpCommandContext(interaction, { rest, applicationId: config.discord.clientId, ephemeral: command.ephemeral === true }),
      );
    },
    announce: (guild, text) => call.conversation.announce(guild, text),
    currentCall: (): CallSnapshot | undefined => {
      const session = call.voice.get(guildId);
      if (!session) return undefined;
      return { channelId: session.channelId, channelName: session.channel.name, people: session.presentMembers(), music: call.music.describe(guildId) };
    },
    // Pick up spending from /chat in Lambda, so the cap is announced here if that crossed it.
    onHeartbeat: () => core.usage.refresh(guildId),
    idleExitMs: settings.VOICE_TASK_IDLE_EXIT_SECONDS * 1000,
    clock,
    logger,
  });
  // ECS sends SIGTERM before stopping the container (a deploy, or someone stopping it).
  process.once('SIGTERM', () => {
    logger.info('Asked to stop.');
    runner.stop();
  });

  logger.info('Voice task ready for orders.');
  await runner.run();

  await call.voice.leaveAll();
  // Let the last call's recap finish before the container goes away.
  await call.recapper.idle();
  await store.clear(guildId).catch((error: unknown) => logger.warn(`Could not clear the voice task record: ${describeError(error)}`));
  await bot.stop();
  await core.close();
  logger.info('Voice task finished.');
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(error instanceof ConfigError ? `${error.message}\n` : `Voice task failed: ${describeError(error)}\n`);
    process.exit(1);
  },
);
