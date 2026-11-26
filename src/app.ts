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
import { resetButtons, resetCommand } from './discord/commands/reset.js';
import { joinCommand, leaveCommand } from './discord/commands/voice.js';
import { DiscordBot } from './discord/DiscordBot.js';
import { InteractionRouter } from './discord/InteractionRouter.js';
import type { AppServices, BotCommand } from './discord/types.js';
import { describeError, type Logger } from './logging/logger.js';
import { connectMemoryTools } from './memory/inProcess.js';
import { MusicService } from './music/MusicService.js';
import { YouTubeTrackSource } from './music/YouTubeTrackSource.js';
import { PollyTextToSpeech } from './speech/aws/PollyTextToSpeech.js';
import { TranscribeSpeechToText } from './speech/aws/TranscribeSpeechToText.js';
import { openDatabase, openMemoryDatabase } from './storage/sqlite/database.js';
import { SqliteConversationRepository } from './storage/sqlite/SqliteConversationRepository.js';
import { SqliteMemoryRepository } from './storage/sqlite/SqliteMemoryRepository.js';
import { SqliteSettingsRepository } from './storage/sqlite/SqliteSettingsRepository.js';
import { SqliteTranscriptRepository } from './storage/sqlite/SqliteTranscriptRepository.js';
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
  // Storage ------------------------------------------------------------------
  const db = openDatabase(config.storage.databasePath);
  const conversations = new SqliteConversationRepository(db);
  const transcripts = new SqliteTranscriptRepository(db);
  const settings = new SqliteSettingsRepository(db, clock);
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
    if (segments + messages > 0) logger.info(`Retention: deleted ${segments} transcript line(s) and ${messages} archived message(s).`);
  };
  await sweepRetention();
  const retentionTimer = setInterval(() => {
    sweepRetention().catch((error: unknown) => logger.warn(`Retention sweep failed: ${describeError(error)}`));
  }, RETENTION_SWEEP_MS);
  retentionTimer.unref();

  // Claude ---------------------------------------------------------------------
  logger.info(`Reaching Claude through ${describeClaudeAccess(config.claude.access)}.`);
  const claude = await createClaudeClient(config.claude.access);
  await verifyClaudeAccess(claude, config.claude.access, [config.claude.chat.model, config.claude.voice.model], logger);
  const memory = await connectMemoryTools({ transcripts, conversations, memories });

  // Discord, speech, voice, music ------------------------------------------------
  const bot = new DiscordBot({
    token: config.discord.token,
    clientId: config.discord.clientId,
    guildId: config.discord.guildId,
    logger,
  });
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
    transcripts,
    resolveChannel: (guildId, channelId) => bot.resolveVoiceChannel(guildId, channelId),
  });
  const music = new MusicService(voice, new YouTubeTrackSource(), logger);
  voice.onSessionEnded((guildId) => music.detach(guildId));

  // Assistant -------------------------------------------------------------------
  const tools = new ToolRegistry([memory.provider, createMusicToolProvider(music), createVoiceToolProvider(voice)]);
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
  });
  const voiceConversation = new VoiceConversationService({
    assistant,
    transcripts,
    music,
    wakeWord: new KeywordDetector(config.assistant.wakeWord),
    logger,
    clock,
    assistantName: config.assistant.name,
    botUserId: () => bot.userId,
    ambientContextMinutes: config.assistant.ambientContextMinutes,
    wakeSound: config.assistant.wakeSound ? renderWakeChime() : undefined,
  });
  voice.setUtteranceHandler(voiceConversation.handleUtterance);

  // Commands --------------------------------------------------------------------
  const commands: BotCommand[] = [
    chatCommand,
    customizeCommand,
    resetCommand,
    memoriesCommand,
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
    voice,
    music,
    commands: () => commands,
  };
  const router = new InteractionRouter(commands, [resetButtons, memoriesComponents], services);
  await bot.registerCommands(commands);
  await bot.start(router);

  let stopping: Promise<void> | undefined;
  return {
    stop() {
      stopping ??= (async () => {
        clearInterval(retentionTimer);
        await voice.leaveAll();
        await memory.close().catch((error: unknown) => logger.warn(`Closing memory MCP: ${describeError(error)}`));
        await bot.stop();
        db.close();
        memoryDb.close();
        logger.info('Shut down cleanly.');
      })();
      return stopping;
    },
  };
}
