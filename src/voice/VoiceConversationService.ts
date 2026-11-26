import type { Assistant } from '../assistant/Assistant.js';
import type { Logger } from '../logging/logger.js';
import { describeError } from '../logging/logger.js';
import type { MusicService } from '../music/MusicService.js';
import type { TranscriptRepository } from '../storage/ports.js';
import { toSpeakableText } from '../util/text.js';
import type { Clock } from '../util/time.js';
import type { KeywordDetector } from './keywordDetection.js';
import type { CapturedUtterance } from './SpeechCapture.js';
import type { VoiceSession } from './VoiceSession.js';

export interface VoiceConversationDeps {
  assistant: Assistant;
  transcripts: TranscriptRepository;
  music: MusicService;
  wakeWord: KeywordDetector;
  logger: Logger;
  clock: Clock;
  assistantName: string;
  /** Discord user id of the bot, used as the speaker id for its own lines. */
  botUserId: () => string;
  ambientContextMinutes: number;
  /**
   * Short sound (48 kHz 16-bit stereo PCM) played when the assistant hears its name, so people know
   * it's thinking. Undefined means no sound.
   */
  wakeSound?: Buffer;
}

const MAX_AMBIENT_SEGMENTS = 40;

/**
 * Handles every transcribed utterance in a listening voice channel:
 *  1. records it in the ambient transcript (group memory),
 *  2. if it contains the wake word, asks the assistant (with the last few minutes of
 *     conversation as context) and speaks the reply,
 *  3. records the spoken reply in the transcript too.
 */
export class VoiceConversationService {
  constructor(private readonly deps: VoiceConversationDeps) {}

  readonly handleUtterance = async (session: VoiceSession, utterance: CapturedUtterance): Promise<void> => {
    const { deps } = this;
    const transcriptSessionId = session.transcriptSessionId;
    if (transcriptSessionId === undefined) return;

    const member = await session.resolveMember(utterance.userId);
    if (member?.user.bot) return;
    const speakerName = member?.displayName ?? `user ${utterance.userId}`;

    const segment = await deps.transcripts.appendSegment({
      sessionId: transcriptSessionId,
      guildId: session.guildId,
      channelId: session.channelId,
      speakerId: utterance.userId,
      speakerName,
      isAssistant: false,
      text: utterance.text,
      startedAt: utterance.startedAt,
      endedAt: utterance.endedAt,
    });
    deps.logger.debug(`[#${session.channel.name}] ${speakerName}: ${utterance.text}`);

    if (!deps.wakeWord.containsKeyword(utterance.text)) return;
    deps.logger.info(`Wake word from ${speakerName} in #${session.channel.name}: "${utterance.text}"`);

    // From here until the reply has been spoken, music stays quiet; the chime says "I'm on it".
    const releaseMusic = session.holdMusic();
    try {
      if (deps.wakeSound) session.playEarcon(deps.wakeSound);
      await this.answer(session, transcriptSessionId, segment.id, utterance, speakerName);
    } finally {
      releaseMusic();
    }
  };

  private async answer(
    session: VoiceSession,
    transcriptSessionId: number,
    utteranceSegmentId: number,
    utterance: CapturedUtterance,
    speakerName: string,
  ): Promise<void> {
    const { deps } = this;
    const since = utterance.startedAt - deps.ambientContextMinutes * 60_000;
    const ambient =
      deps.ambientContextMinutes > 0
        ? (await deps.transcripts.recentSegments(transcriptSessionId, since, MAX_AMBIENT_SEGMENTS + 1)).filter(
            (s) => s.id !== utteranceSegmentId,
          )
        : [];

    let reply;
    try {
      reply = await deps.assistant.respond({
        scope: { guildId: session.guildId, userId: utterance.userId },
        modality: 'voice',
        userDisplayName: speakerName,
        text: utterance.text,
        channelName: session.channel.name,
        userVoiceChannelId: session.channelId,
        userVoiceChannelName: session.channel.name,
        peoplePresent: session.presentMembers(),
        musicStatus: deps.music.describe(session.guildId),
        ambient: ambient.slice(-MAX_AMBIENT_SEGMENTS),
      });
    } catch (error) {
      deps.logger.error(`Assistant failed to answer ${speakerName}: ${describeError(error)}`);
      await session.speak("Sorry, something went wrong on my end.");
      return;
    }

    if (reply.silent) return;
    const spoken = toSpeakableText(reply.text);
    if (spoken.length === 0) return;
    if (reply.sources.length > 0) {
      deps.logger.info(`Spoken reply used web sources: ${reply.sources.map((s) => s.url).join(', ')}`);
    }

    const now = deps.clock();
    await deps.transcripts.appendSegment({
      sessionId: transcriptSessionId,
      guildId: session.guildId,
      channelId: session.channelId,
      speakerId: deps.botUserId(),
      speakerName: deps.assistantName,
      isAssistant: true,
      text: spoken,
      startedAt: now,
      endedAt: now,
    });
    await session.speak(spoken);
  }
}
