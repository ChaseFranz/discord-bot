import { Assistant, type AssistantRoute } from './assistant/Assistant.js';
import { createMusicToolProvider } from './assistant/tools/musicTools.js';
import { ToolRegistry } from './assistant/tools/ToolRegistry.js';
import { createVoiceToolProvider } from './assistant/tools/voiceTools.js';
import { createClaudeClient, describeClaudeAccess, verifyClaudeAccess } from './claude/client.js';
import type { AppConfig } from './config/config.js';
import { chatCommand } from './discord/commands/chat.js';
import { customizeCommand } from './discord/commands/customize.js';
import { memoriesCommand, memoriesComponents } from './discord/commands/memories.js';
import { helpCommand } from './discord/commands/help.js';
import {
  pauseCommand,
  playCommand,
  queueCommand,
  resumeCommand,
  skipCommand,
  stopCommand,
} from './discord/commands/music.js';
import { privacyCommand } from './discord/commands/privacy.js';
import { resetButtons, resetCommand } from './discord/commands/reset.js';
import { usageCommand } from './discord/commands/usage.js';
import { joinCommand, leaveCommand } from './discord/commands/voice.js';
import { DiscordBot } from './discord/DiscordBot.js';
import { InteractionRouter } from './discord/InteractionRouter.js';
import { MentionChat } from './discord/MentionChat.js';
import type { AppServices, BotCommand } from './discord/types.js';
import { describeError, type Logger } from './logging/logger.js';
import { connectMemoryTools } from './memory/inProcess.js';
import { MusicService } from './music/MusicService.js';
import { YouTubeTrackSource } from './music/YouTubeTrackSource.js';
import { PrivacyService } from './privacy/PrivacyService.js';
import { CallRecapper } from './recaps/CallRecapper.js';
import { createReminderDelivery } from './reminders/ReminderDelivery.js';
import { ReminderScheduler } from './reminders/ReminderScheduler.js';
import { createReminderToolProvider } from './reminders/reminderTools.js';
import { PollyTextToSpeech } from './speech/aws/PollyTextToSpeech.js';
import { TranscribeSpeechToText } from './speech/aws/TranscribeSpeechToText.js';
import { openDatabase, openMemoryDatabase } from './storage/sqlite/database.js';
import { SqliteConversationRepository } from './storage/sqlite/SqliteConversationRepository.js';
import { SqliteMemoryRepository } from './storage/sqlite/SqliteMemoryRepository.js';
import { SqliteReminderRepository } from './storage/sqlite/SqliteReminderRepository.js';
import { SqliteSettingsRepository } from './storage/sqlite/SqliteSettingsRepository.js';
import { SqliteTranscriptRepository } from './storage/sqlite/SqliteTranscriptRepository.js';
import { SqliteUsageRepository } from './storage/sqlite/SqliteUsageRepository.js';
import { PriceBook } from './usage/pricing.js';
import { UsageService } from './usage/UsageService.js';
import { systemSchedule } from './util/schedule.js';
import { systemClock, type Clock } from './util/time.js';
import { KeywordDetector } from './voice/keywordDetection.js';
import { renderWakeChime } from './voice/earcon.js';
import { DEFAULT_CAPTURE_OPTIONS } from './voice/SpeechCapture.js';
import { VoiceConversationService } from './voice/VoiceConversationService.js';
import { VoiceSessionManager } from './voice/VoiceSessionManager.js';

export interface RunningApp {
  stop(): Promise<void>;
}

const RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000;
/** On startup, recap calls from the last day that ended without one. */
const RECAP_CATCH_UP_MS = 24 * 60 * 60 * 1000;

/** Builds the assistant's model routes from configuration. */
export function buildRoutes(config: AppConfig): Record<'text' | 'voice', AssistantRoute> {
  const search = config.claude.webSearchEnabled;
  return {
    text: {
      model: config.claude.chat.model,
      effort: config.claude.chat.effort,
      maxTokens: 16_000,
      timeoutMs: 5 * 60_000,
      webSearchMaxUses: search ? 5 : undefined,
    },
    voice: {
      model: config.claude.voice.model,
      effort: config.claude.voice.effort,
      maxTokens: 8_000,
      timeoutMs: 60_000,
      webSearchMaxUses: search ? 2 : undefined,
    },
  };
}

export async function startApp(config: AppConfig, logger: Logger, clock: Clock = systemClock): Promise<RunningApp> {
  const guildId = config.discord.guildId;

  // Storage ------------------------------------------------------------------
  const db = openDatabase(config.storage.databasePath);
  const conversations = new SqliteConversationRepository(db);
  const transcripts = new SqliteTranscriptRepository(db);
  const settings = new SqliteSettingsRepository(db, clock);
  const reminders = new SqliteReminderRepository(db, clock);
  // Long-term notes about people live in their own database.
  const memoryDb = openMemoryDatabase(config.storage.memoryDatabasePath);
  const memories = new SqliteMemoryRepository(memoryDb);
  const closedSessions = await transcripts.endOpenSessions(clock());
  if (closedSessions > 0) logger.info(`Closed ${closedSessions} voice session(s) left open by the last run.`);

  const sweepRetention = async () => {
    const days = config.storage.retentionDays;
    if (days <= 0) return;
    const cutoff = clock() - days * 24 * 60 * 60 * 1000;
    const segments = await transcripts.pruneBefore(cutoff);
    const messages = await conversations.pruneArchivedBefore(cutoff);
    const finished = await reminders.pruneFinishedBefore(cutoff);
    if (segments + messages + finished > 0) {
      logger.info(`Retention: deleted ${segments} transcript line(s), ${messages} archived message(s) and ${finished} old reminder(s).`);
    }
  };
  await sweepRetention();
  const retentionTimer = setInterval(() => {
    sweepRetention().catch((error: unknown) => logger.warn(`Retention sweep failed: ${describeError(error)}`));
  }, RETENTION_SWEEP_MS);
  retentionTimer.unref();

  // Usage and privacy ------------------------------------------------------------
  const usage = new UsageService({
    repository: new SqliteUsageRepository(db),
    prices: new PriceBook({
      transcribeUsdPerMinute: config.usage.transcribeUsdPerMinute,
      pollyEngine: config.aws.pollyEngine,
      pollyUsdPerMillionCharacters: config.usage.pollyUsdPerMillionCharacters,
    }),
    clock,
    timeZone: config.assistant.timeZone,
    dailyBudgetUsd: config.usage.dailyBudgetUsd,
    pollyEngine: config.aws.pollyEngine,
    logger,
  });
  await usage.load(guildId);
  const today = usage.status(guildId);
  logger.info(
    today.budgetUsd === null
      ? `Spent so far today: $${today.spentUsd.toFixed(2)} (no daily cap).`
      : `Spent so far today: $${today.spentUsd.toFixed(2)} of the $${today.budgetUsd.toFixed(2)} daily budget.`,
  );
  const privacy = new PrivacyService(settings);

  // Claude ---------------------------------------------------------------------
  logger.info(`Reaching Claude through ${describeClaudeAccess(config.claude.access)}.`);
  const claude = await createClaudeClient(config.claude.access);
  await verifyClaudeAccess(claude, config.claude.access, [config.claude.chat.model, config.claude.voice.model], logger);
  const memory = await connectMemoryTools({ transcripts, conversations, memories });

  // Discord, speech, voice, music ------------------------------------------------
  const bot = new DiscordBot({ token: config.discord.token, clientId: config.discord.clientId, guildId, logger });
  const stt = new TranscribeSpeechToText({ region: config.aws.region, languageCode: config.aws.transcribeLanguageCode });
  const tts = new PollyTextToSpeech({ region: config.aws.region, voiceId: config.aws.pollyVoiceId, engine: config.aws.pollyEngine });
  // Voice features need AWS; text chat doesn't, so a problem here is reported but not fatal.
  try {
    const problem = await tts.verify();
    if (problem) logger.error(problem);
    else logger.info(`AWS Polly ready (${config.aws.pollyVoiceId}, ${config.aws.pollyEngine}, ${config.aws.region}).`);
  } catch (error) {
    logger.error(`AWS check failed; voice replies and transcription won't work until this is fixed: ${describeError(error)}`);
  }
  const voice = new VoiceSessionManager({
    logger,
    stt,
    tts,
    clock,
    capture: DEFAULT_CAPTURE_OPTIONS,
    // Nothing is captured from people who opted out, or from anyone once today's budget is spent.
    admitSpeaker: async (guild, userId) => !usage.isPaused(guild) && (await privacy.level(guild, userId)) !== 'off',
    meter: usage,
    transcripts,
    resolveChannel: (guild, channelId) => bot.resolveVoiceChannel(guild, channelId),
    botUserId: () => bot.userId,
    autoLeaveMs: config.assistant.autoLeaveMinutes * 60_000,
    schedule: systemSchedule,
  });
  const music = new MusicService(voice, new YouTubeTrackSource(), logger);

  // Assistant -------------------------------------------------------------------
  let scheduler: ReminderScheduler | undefined;
  const tools = new ToolRegistry([
    memory.provider,
    createMusicToolProvider(music),
    createVoiceToolProvider(voice),
    createReminderToolProvider({ reminders, changed: () => scheduler?.changed(), clock, timeZone: config.assistant.timeZone }),
  ]);
  const assistant = new Assistant({
    messages: claude.beta.messages,
    conversations,
    settings,
    tools,
    logger,
    clock,
    assistantName: config.assistant.name,
    timeZone: config.assistant.timeZone,
    routes: buildRoutes(config),
    memories,
    usage,
    budget: usage,
  });
  const voiceConversation = new VoiceConversationService({
    assistant,
    transcripts,
    music,
    sessions: voice,
    privacy,
    budget: usage,
    wakeWord: new KeywordDetector(config.assistant.wakeWord),
    logger,
    clock,
    assistantName: config.assistant.name,
    botUserId: () => bot.userId,
    ambientContextMinutes: config.assistant.ambientContextMinutes,
    followUpMs: config.assistant.followUpSeconds * 1000,
    wakeSound: config.assistant.wakeSound ? renderWakeChime() : undefined,
  });
  voice.setUtteranceHandler(voiceConversation.handleUtterance);
  voice.onSessionEnded((guild) => {
    music.detach(guild);
    voiceConversation.sessionEnded(guild);
  });

  // Call recaps, the daily budget, privacy changes ----------------------------------
  const recapper = new CallRecapper({
    messages: claude.beta.messages,
    transcripts,
    usage,
    budget: usage,
    model: config.claude.voice.model,
    effort: config.claude.voice.effort,
    assistantName: config.assistant.name,
    timeZone: config.assistant.timeZone,
    clock,
    logger,
  });
  voice.onTranscriptEnded((record) => recapper.sessionEnded(record));
  usage.onThreshold((guild, state) => {
    if (state !== 'paused') return;
    void voiceConversation
      .announce(guild, "Heads up: I've hit today's spending limit, so I'm going to stop listening until midnight.")
      .catch((error: unknown) => logger.warn(`Could not announce the budget pause: ${describeError(error)}`));
  });
  // Opting out takes effect mid-sentence: stop sending what they're saying right now.
  privacy.onChange((guild, userId, level) => {
    if (level === 'off') voice.get(guild)?.cancelCapture(userId);
  });

  // Reminders --------------------------------------------------------------------
  scheduler = new ReminderScheduler({
    reminders,
    deliver: createReminderDelivery({
      voice: {
        callMembers: (guild) => voice.get(guild)?.presentMembers(),
        announce: (guild, text) => voiceConversation.announce(guild, text),
      },
      messenger: bot,
      logger,
    }),
    clock,
    schedule: systemSchedule,
    logger,
  });

  // Commands and messages ----------------------------------------------------------
  const commands: BotCommand[] = [
    chatCommand,
    customizeCommand,
    resetCommand,
    memoriesCommand,
    privacyCommand,
    usageCommand,
    helpCommand,
    joinCommand,
    leaveCommand,
    playCommand,
    skipCommand,
    stopCommand,
    queueCommand,
    pauseCommand,
    resumeCommand,
  ];
  const services: AppServices = {
    config,
    logger,
    assistant,
    conversations,
    settings,
    memories,
    privacy,
    usage,
    voice,
    music,
    commands: () => commands,
  };
  const router = new InteractionRouter(commands, [resetButtons, memoriesComponents], services);
  const mentions = new MentionChat(services, { guildId, botUserId: () => bot.userId });
  await bot.registerCommands(commands);
  await bot.start({
    interactions: router,
    messages: mentions.handle,
    voiceStates: (change) => voice.voiceStateChanged(change),
  });

  // Needs Discord to be connected: reminders that came due while the bot was off go out now.
  scheduler.start();
  recapper.catchUp(clock() - RECAP_CATCH_UP_MS).catch((error: unknown) => logger.warn(`Recap catch-up failed: ${describeError(error)}`));

  let stopping: Promise<void> | undefined;
  return {
    stop() {
      stopping ??= (async () => {
        clearInterval(retentionTimer);
        scheduler?.stop();
        // Recaps of calls cut short by the shutdown are written on the next start.
        await recapper.stop();
        await voice.leaveAll();
        await scheduler?.idle();
        await memory.close().catch((error: unknown) => logger.warn(`Closing memory MCP: ${describeError(error)}`));
        await bot.stop();
        await usage.flush();
        db.close();
        memoryDb.close();
        logger.info('Shut down cleanly.');
      })();
      return stopping;
    },
  };
}
