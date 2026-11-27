import type { Assistant } from '../assistant/Assistant.js';
import { createMusicToolProvider } from '../assistant/tools/musicTools.js';
import { createVoiceToolProvider } from '../assistant/tools/voiceTools.js';
import type { DiscordBot } from '../discord/DiscordBot.js';
import { describeError } from '../logging/logger.js';
import { MusicService } from '../music/MusicService.js';
import type { MusicRelay } from '../music/relay/HelperDesk.js';
import { HelperTrackSource } from '../music/relay/HelperTrackSource.js';
import type { TrackSource } from '../music/types.js';
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
export async function buildCallStack(core: Core, bot: DiscordBot, alarm: ReminderAlarm, relay?: MusicRelay): Promise<CallStack> {
  const { config, logger, clock, storage, usage, privacy } = core;
  const stt = new TranscribeSpeechToText({ region: config.aws.region, languageCode: config.aws.transcribeLanguageCode });
  const tts = new PollyTextToSpeech({
    region: config.aws.region,
    voiceId: config.aws.pollyVoiceId,
    engine: config.aws.pollyEngine,
    streaming: config.aws.pollyStreaming,
    logger,
  });
  // Voice features need AWS; text chat doesn't, so a problem here is reported but not fatal.
  try {
    const problem = await tts.verify();
    if (problem) logger.error(problem);
    else logger.info(`AWS Polly ready (${config.aws.pollyVoiceId}, ${config.aws.pollyEngine}${config.aws.pollyStreaming && config.aws.pollyEngine === 'generative' ? ', streamed replies' : ''}, ${config.aws.region}).`);
  } catch (error) {
    logger.error(`AWS check failed; voice replies and transcription won't work until this is fixed: ${describeError(error)}`);
  }

  const voice = new VoiceSessionManager({
    logger,
    stt,
    tts,
    clock,
    capture: { ...DEFAULT_CAPTURE_OPTIONS, silenceMs: config.call.silenceMs },
    // Nothing is captured from people who opted out, or from anyone once today's budget is spent.
    // Asked when someone starts talking and every second while they do, and read from storage each
    // time: on AWS /privacy is handled by another process, and this is how a choice made there holds here.
    admitSpeaker: async (guild, userId) => !usage.isPaused(guild) && (await privacy.level(guild, userId)) !== 'off',
    meter: usage,
    transcripts: storage.transcripts,
    resolveChannel: (guild, channelId) => bot.resolveVoiceChannel(guild, channelId),
    botUserId: () => bot.userId,
    autoLeaveMs: config.assistant.autoLeaveMinutes * 60_000,
    schedule: systemSchedule,
  });
  let tracks: TrackSource;
  if (relay) {
    // YouTube won't serve this bot directly: a music helper on someone's own computer fetches for it.
    tracks = new HelperTrackSource({ guildId: config.discord.guildId, desk: relay.desk, board: relay.board, store: relay.store, clock });
    if (config.music.enabled) logger.info('Music is fetched by music helpers (see /musichelper).');
  } else {
    const direct = new YtDlpTrackSource({ executable: config.music.ytDlpPath });
    tracks = direct;
    if (config.music.enabled) {
      // Music needs yt-dlp; nothing else does, so a missing one is reported but not fatal.
      try {
        logger.info(`yt-dlp ${await direct.version()} ready for music.`);
      } catch (error) {
        logger.error(`Music won't play until yt-dlp works: ${describeError(error)}`);
      }
    }
  }
  if (!config.music.enabled) logger.info('Music is turned off (MUSIC_ENABLED=false): the music commands and Nimbus will say so.');
  const music = new MusicService(voice, tracks, logger);

  const assistant = core.assistant([
    createMusicToolProvider(music, { enabled: config.music.enabled }),
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
    timeZone: config.assistant.timeZone,
    followUps: config.call.followUps,
    followUpMs: config.assistant.followUpSeconds * 1000,
    bargeIn: config.call.bargeIn,
    bargeInMs: config.call.bargeInMs,
    acknowledge: config.call.acknowledge,
    silenceMs: config.call.silenceMs,
    wakeSound: config.assistant.wakeSound ? renderWakeChime() : undefined,
  });
  voice.setCallListener(conversation);
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
  // Opting out through this process takes effect at once: stop sending what they're saying right now.
  privacy.onChange((guild, userId, level) => {
    if (level === 'off') voice.get(guild)?.cancelCapture(userId);
  });

  return { voice, music, assistant, conversation, recapper };
}
