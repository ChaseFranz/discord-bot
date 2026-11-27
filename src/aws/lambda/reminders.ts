import { loadConfig } from '../../config/config.js';
import { RestMessenger, createDiscordRest } from '../../discord/http.js';
import { createLogger } from '../../logging/logger.js';
import { createReminderDelivery } from '../../reminders/ReminderDelivery.js';
import { handleReminderWakeUp, type ReminderWakeUp, type WakeUpDeps } from '../../reminders/wakeUp.js';
import { openStorage } from '../../storage/open.js';
import { systemClock } from '../../util/time.js';
import { reminderAlarm, voiceTaskPlumbing } from '../plumbing.js';
import { loadAwsSettings, loadSecrets } from '../settings.js';

/**
 * Lambda woken shortly before a reminder is due (by EventBridge Scheduler, or directly for ones
 * due within minutes). It waits for the exact time, then has the voice task say it if the person
 * is in a call with the bot, or posts it as a mention.
 */
let ready: Promise<WakeUpDeps> | undefined;

/** The function's timeout is 15 minutes; wake-ups arrive at most 12 minutes early. */
const MAX_WAIT_MS = 13 * 60_000;

export async function handler(event: ReminderWakeUp): Promise<string> {
  ready ??= createDeps().catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  return handleReminderWakeUp(event, await ready);
}

async function createDeps(): Promise<WakeUpDeps> {
  await loadSecrets();
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const settings = loadAwsSettings(['VOICE_QUEUE_URL', 'REMINDER_FUNCTION_ARN', 'REMINDER_SCHEDULE_GROUP', 'REMINDER_SCHEDULER_ROLE_ARN']);
  const clock = systemClock;
  const storage = openStorage(config.storage.backend, { retentionDays: config.storage.retentionDays, clock });
  const { announcer } = voiceTaskPlumbing(config, settings, clock);
  return {
    reminders: storage.reminders,
    alarm: reminderAlarm(settings, clock),
    deliver: createReminderDelivery({ voice: announcer, messenger: new RestMessenger(createDiscordRest(config.discord.token)), logger }),
    clock,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    logger,
    maxWaitMs: MAX_WAIT_MS,
  };
}
