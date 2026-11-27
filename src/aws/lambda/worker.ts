import { ECSClient } from '@aws-sdk/client-ecs';
import type { APIInteraction } from 'discord-api-types/v10';
import { VoiceTaskControl } from '../../calls/voiceTask.js';
import { loadConfig } from '../../config/config.js';
import { CommandDispatcher } from '../../discord/CommandDispatcher.js';
import { RestCallInfo, createDiscordRest } from '../../discord/http.js';
import type { AppServices } from '../../discord/types.js';
import { createLogger } from '../../logging/logger.js';
import { createReminderToolProvider } from '../../reminders/reminderTools.js';
import { allCommands, openCore } from '../../runtime/core.js';
import { systemClock } from '../../util/time.js';
import { EcsVoiceTaskLauncher } from '../adapters.js';
import { musicRelay, reminderAlarm, voiceTaskPlumbing } from '../plumbing.js';
import { loadAwsSettings, loadSecrets } from '../settings.js';
import { InteractionWorker } from '../worker.js';

/**
 * Lambda that runs slash commands and button clicks handed over by the edge. Built once per warm
 * container and reused across invocations.
 */
let ready: Promise<InteractionWorker> | undefined;

export async function handler(event: unknown): Promise<void> {
  const interaction = (typeof event === 'string' ? JSON.parse(event) : event) as APIInteraction;
  ready ??= createWorker().catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  await (await ready).handle(interaction);
}

async function createWorker(): Promise<InteractionWorker> {
  await loadSecrets();
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const settings = loadAwsSettings([
    'VOICE_QUEUE_URL',
    'VOICE_TASK_CLUSTER',
    'VOICE_TASK_DEFINITION',
    'VOICE_TASK_SUBNETS',
    'VOICE_TASK_SECURITY_GROUPS',
    'REMINDER_FUNCTION_ARN',
    'REMINDER_SCHEDULE_GROUP',
    'REMINDER_SCHEDULER_ROLE_ARN',
  ]);
  const clock = systemClock;
  const core = await openCore(config, logger, clock, { verifyClaude: false });
  const { store, queue, announcer } = voiceTaskPlumbing(config, settings, clock);
  const rest = createDiscordRest(config.discord.token);
  const calls = new RestCallInfo(rest, { get: (guildId) => announcer.currentCall(guildId) });
  const assistant = core.assistant([
    createReminderToolProvider({ reminders: core.storage.reminders, alarm: reminderAlarm(settings, clock), clock, timeZone: config.assistant.timeZone }),
  ]);
  const { commands, components } = allCommands();
  const services: AppServices = {
    config,
    logger,
    assistant,
    conversations: core.storage.conversations,
    settings: core.storage.settings,
    memories: core.storage.memories,
    privacy: core.privacy,
    usage: core.usage,
    calls,
    musicHelpers: musicRelay(config, clock)?.desk,
    commands: () => commands,
    mentionChat: false,
  };
  const control = new VoiceTaskControl({
    store,
    queue,
    launcher: new EcsVoiceTaskLauncher(new ECSClient({}), {
      cluster: settings.VOICE_TASK_CLUSTER,
      taskDefinition: settings.VOICE_TASK_DEFINITION,
      subnets: settings.VOICE_TASK_SUBNETS,
      securityGroups: settings.VOICE_TASK_SECURITY_GROUPS,
    }),
    calls,
    clock,
    logger,
  });
  return new InteractionWorker({
    guildId: config.discord.guildId,
    applicationId: config.discord.clientId,
    rest,
    dispatcher: new CommandDispatcher(commands, components, services),
    control,
    usage: core.usage,
    logger,
  });
}
