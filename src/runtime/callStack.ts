import type { Assistant } from '../assistant/Assistant.js';
import { createMusicToolProvider } from '../assistant/tools/musicTools.js';
import { createVoiceToolProvider } from '../assistant/tools/voiceTools.js';
import type { DiscordBot } from '../discord/DiscordBot.js';
import { describeError } from '../logging/logger.js';
import { MusicService } from '../music/MusicService.js';
import { YtDlpTrackSource } from '../music/YtDlpTrackSource.js';
import { CallRecapper } from '../recaps/CallRecapper.js';
import type { ReminderAlarm } from '../reminders/alarm.js';
import { createReminderToolProvider } from '../reminders/reminderTools.js';
import { PollyTextToSpeech } from '../speech/aws/PollyTextToSpeech.js';
import { TranscribeSpeechToText } from '../speech/aws/TranscribeSpeechToText.js';
import { systemSchedule } from '../util/schedule.js';
import { KeywordDetector } from '../voice/keywordDetection.js';
import { renderWakeChime } from '../voice/earcon.js';
import { DEFAULT_CAPTURE_OPTIONS } from '../voice/SpeechCapture.js';
import { VoiceConversationService } from '../voice/VoiceConversationService.js';
import { VoiceSessionManager } from '../voice/VoiceSessionManager.js';
import type { Core } from './core.js';

/** Everything that handles calls: wherever the bot joins voice channels (a PC, or the voice task). */
export interface CallStack {
  voice: VoiceSessionManager;
  music: MusicService;
  assistant: Assistant;
  conversation: VoiceConversationService;
  recapper: CallRecapper;
}

/**
 * Builds the voice side: speech in and out, voice sessions, music, the voice conversation flow,
 * call recaps, the spoken budget announcement, and privacy changes taking effect mid-sentence.
 */
export async function buildCallStack(core: Core, bot: DiscordBot, alarm: ReminderAlarm): Promise<CallStack> {
  const { config, logger, clock, storage, usage, privacy } = core;
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
    transcripts: storage.transcripts,
    resolveChannel: (guild, channelId) => bot.resolveVoiceChannel(guild, channelId),
    botUserId: () => bot.userId,
    autoLeaveMs: config.assistant.autoLeaveMinutes * 60_000,
    schedule: systemSchedule,
  });
  const tracks = new YtDlpTrackSource({ executable: config.music.ytDlpPath });
  // Music needs yt-dlp; nothing else does, so a missing one is reported but not fatal.
  try {
    logger.info(`yt-dlp ${await tracks.version()} ready for music.`);
  } catch (error) {
    logger.error(`Music won't play until yt-dlp works: ${describeError(error)}`);
  }
  const music = new MusicService(voice, tracks, logger);

  const assistant = core.assistant([
    createMusicToolProvider(music),
    createVoiceToolProvider(voice),
    createReminderToolProvider({ reminders: storage.reminders, alarm, clock, timeZone: config.assistant.timeZone }),
  ]);
  const conversation = new VoiceConversationService({
    assistant,
    transcripts: storage.transcripts,
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
  voice.setUtteranceHandler(conversation.handleUtterance);
  voice.onSessionEnded((guild) => {
    music.detach(guild);
    conversation.sessionEnded(guild);
  });

  const recapper = new CallRecapper({
    messages: core.claude.beta.messages,
    transcripts: storage.transcripts,
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
    void conversation
      .announce(guild, "Heads up: I've hit today's spending limit, so I'm going to stop listening until midnight.")
      .catch((error: unknown) => logger.warn(`Could not announce the budget pause: ${describeError(error)}`));
  });
  // Opting out takes effect mid-sentence: stop sending what they're saying right now.
  privacy.onChange((guild, userId, level) => {
    if (level === 'off') voice.get(guild)?.cancelCapture(userId);
  });

  return { voice, music, assistant, conversation, recapper };
}
