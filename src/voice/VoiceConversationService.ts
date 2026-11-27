import { BudgetExceededError, type AssistantReply, type AssistantRequest } from '../assistant/Assistant.js';
import type { Logger } from '../logging/logger.js';
import { describeError } from '../logging/logger.js';
import { MusicError, type MusicStatus } from '../music/types.js';
import type { PrivacyLevel, TranscriptRepository } from '../storage/ports.js';
import { toSpeakableText } from '../util/text.js';
import type { Clock } from '../util/time.js';
import type { KeywordDetector } from './keywordDetection.js';
import { SentenceChunker } from './SentenceChunker.js';
import type { CapturedUtterance } from './SpeechCapture.js';
import { parseVoiceCommand } from './voiceCommands.js';
import type { VoiceSession } from './VoiceSession.js';

export interface VoiceConversationDeps {
  assistant: { respond(request: AssistantRequest): Promise<AssistantReply> };
  transcripts: TranscriptRepository;
  music: {
    describe(guildId: string): string;
    status(guildId: string): MusicStatus;
    pause(guildId: string): unknown;
  };
  /** The guild's current voice session, if any (for announcements). */
  sessions: { get(guildId: string): VoiceSession | undefined };
  privacy: { level(guildId: string, userId: string): Promise<PrivacyLevel> };
  budget: { isPaused(guildId: string): boolean };
  wakeWord: KeywordDetector;
  logger: Logger;
  clock: Clock;
  assistantName: string;
  /** Discord user id of the bot, used as the speaker id for its own lines. */
  botUserId: () => string;
  ambientContextMinutes: number;
  /** How long after a reply the same person can carry on without the wake word; 0 turns this off. */
  followUpMs: number;
  /**
   * Short sound (48 kHz 16-bit stereo PCM) played when the assistant hears its name, so people know
   * it's thinking. Undefined means no sound.
   */
  wakeSound?: Buffer;
}

/** Where a person stands in a back-and-forth with the assistant. */
interface Engagement {
  /** True from when their request is accepted until the reply has been spoken. */
  answering: boolean;
  /** After the reply: utterances starting in [from, until] are follow-ups. */
  followUpFrom: number;
  followUpUntil: number;
}

interface ChannelState {
  /** Bumped by "stop": replies already underway stay quiet. */
  generation: number;
  /** Requests waiting on the assistant, so "stop" can cancel them. */
  inFlight: Set<AbortController>;
  engaged: Map<string, Engagement>;
}

const MAX_AMBIENT_SEGMENTS = 40;
/** Longest reply spoken aloud; anything longer stops at a sentence boundary. */
const MAX_SPOKEN_CHARACTERS = 2_500;

/**
 * Handles every transcribed utterance in a listening voice channel:
 *  1. applies the speaker's privacy choice (lines not meant for the assistant may be dropped),
 *  2. records it in the ambient transcript (group memory),
 *  3. if it's addressed to the assistant (its name, or a follow-up right after its reply), either
 *     handles "stop" locally or asks the assistant and speaks the reply sentence by sentence,
 *  4. records the spoken reply in the transcript too.
 */
export class VoiceConversationService {
  private readonly channels = new Map<string, ChannelState>();

  constructor(private readonly deps: VoiceConversationDeps) {}

  readonly handleUtterance = async (session: VoiceSession, utterance: CapturedUtterance): Promise<void> => {
    const { deps } = this;
    const transcriptSessionId = session.transcriptSessionId;
    if (transcriptSessionId === undefined) return;

    const member = await session.resolveMember(utterance.userId);
    if (member?.user.bot) return;
    const speakerName = member?.displayName ?? `user ${utterance.userId}`;
    // Re-checked here: someone may have opted out while they were still talking.
    const privacy = await deps.privacy.level(session.guildId, utterance.userId);
    if (privacy === 'off') return;

    const state = this.state(session.guildId);
    const withoutName = deps.wakeWord.stripKeyword(utterance.text);
    const named = withoutName !== undefined;
    const engagement = state.engaged.get(utterance.userId);
    const followUp =
      !named &&
      engagement !== undefined &&
      !engagement.answering &&
      utterance.startedAt >= engagement.followUpFrom &&
      utterance.startedAt <= engagement.followUpUntil;
    const command = parseVoiceCommand(withoutName ?? utterance.text);
    // While it's answering someone, that person can just say "stop".
    const interruption = !named && !followUp && command === 'stop' && engagement?.answering === true;
    const addressed = named || followUp || interruption;

    // "Only when I'm talking to Nimbus": everything else is dropped unseen, unstored and unlogged.
    if (privacy === 'requests' && !addressed) return;

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
    if (!addressed) return;

    if (command === 'stop') {
      this.stop(session, state, speakerName);
      return;
    }
    if (deps.budget.isPaused(session.guildId)) {
      deps.logger.info(`Not answering ${speakerName}: today's budget is used up.`);
      return;
    }
    deps.logger.info(`${followUp ? 'Follow-up' : 'Wake word'} from ${speakerName} in #${session.channel.name}: "${utterance.text}"`);
    await this.converse(session, state, { transcriptSessionId, utteranceSegmentId: segment.id, utterance, speakerName, followUp });
  };

  /**
   * Says `text` in the guild's voice call (after a chime) and records it in the transcript.
   * Resolves false when the assistant isn't in a call there.
   */
  async announce(guildId: string, text: string): Promise<boolean> {
    const session = this.deps.sessions.get(guildId);
    if (!session) return false;
    const spoken = toSpeakableText(text);
    if (spoken.length === 0) return false;
    const releaseMusic = session.holdMusic();
    try {
      if (this.deps.wakeSound) session.playEarcon(this.deps.wakeSound);
      const startedAt = this.deps.clock();
      await session.speak(spoken);
      await this.recordOwnLine(session, spoken, startedAt);
    } finally {
      releaseMusic();
    }
    return true;
  }

  /** Forgets per-call state once the bot has left a guild's voice channel. */
  sessionEnded(guildId: string): void {
    const state = this.channels.get(guildId);
    if (!state) return;
    for (const controller of state.inFlight) controller.abort();
    this.channels.delete(guildId);
  }

  private state(guildId: string): ChannelState {
    let state = this.channels.get(guildId);
    if (!state) {
      state = { generation: 0, inFlight: new Set(), engaged: new Map() };
      this.channels.set(guildId, state);
    }
    return state;
  }

  /** "Stop": silence everything at once, without asking the assistant. */
  private stop(session: VoiceSession, state: ChannelState, speakerName: string): void {
    state.generation++;
    const cancelled = state.inFlight.size;
    for (const controller of state.inFlight) controller.abort();
    state.inFlight.clear();
    state.engaged.clear();
    const wasSpeaking = session.stopSpeaking();
    if (wasSpeaking || cancelled > 0) {
      this.deps.logger.info(`${speakerName} told ${this.deps.assistantName} to stop.`);
      return;
    }
    // Nothing to interrupt: like a smart speaker, "stop" then means the music (paused, so "resume" works).
    if (this.deps.music.status(session.guildId).state !== 'playing') return;
    try {
      this.deps.music.pause(session.guildId);
      this.deps.logger.info(`${speakerName} said stop; paused the music.`);
    } catch (error) {
      if (!(error instanceof MusicError)) throw error;
    }
  }

  private async converse(
    session: VoiceSession,
    state: ChannelState,
    turn: {
      transcriptSessionId: number;
      utteranceSegmentId: number;
      utterance: CapturedUtterance;
      speakerName: string;
      followUp: boolean;
    },
  ): Promise<void> {
    const { userId } = turn.utterance;
    const generation = state.generation;
    const controller = new AbortController();
    state.inFlight.add(controller);
    state.engaged.set(userId, { answering: true, followUpFrom: 0, followUpUntil: 0 });

    // From here until the reply has been spoken, music stays quiet; the chime says "I'm on it".
    const releaseMusic = session.holdMusic();
    let spoke = false;
    try {
      if (this.deps.wakeSound) session.playEarcon(this.deps.wakeSound);
      spoke = await this.answer(session, controller, turn);
    } finally {
      state.inFlight.delete(controller);
      releaseMusic();
      const current = state.engaged.get(userId);
      if (spoke && generation === state.generation && this.deps.followUpMs > 0) {
        const now = this.deps.clock();
        state.engaged.set(userId, { answering: false, followUpFrom: now, followUpUntil: now + this.deps.followUpMs });
      } else if (current?.answering) {
        state.engaged.delete(userId);
      }
    }
  }

  /** Asks the assistant and speaks the reply as it's written. Resolves true if a reply was spoken in full. */
  private async answer(
    session: VoiceSession,
    controller: AbortController,
    turn: { transcriptSessionId: number; utteranceSegmentId: number; utterance: CapturedUtterance; speakerName: string; followUp: boolean },
  ): Promise<boolean> {
    const { deps } = this;
    const { utterance, speakerName } = turn;
    const since = utterance.startedAt - deps.ambientContextMinutes * 60_000;
    const ambient =
      deps.ambientContextMinutes > 0
        ? (await deps.transcripts.recentSegments(turn.transcriptSessionId, since, MAX_AMBIENT_SEGMENTS + 1)).filter(
            (segment) => segment.id !== turn.utteranceSegmentId,
          )
        : [];

    let speech = session.openReply();
    const spoken: string[] = [];
    let spokenLength = 0;
    let startedAt: number | undefined;
    const say = (piece: string) => {
      const text = toSpeakableText(piece);
      if (text.length === 0 || speech.cancelled || spokenLength + text.length > MAX_SPOKEN_CHARACTERS) return;
      startedAt ??= deps.clock();
      spoken.push(text);
      spokenLength += text.length + 1;
      speech.say(text);
    };
    const chunker = new SentenceChunker(say);

    let reply: AssistantReply;
    try {
      reply = await deps.assistant.respond({
        scope: { guildId: session.guildId, userId: utterance.userId },
        modality: 'voice',
        userDisplayName: speakerName,
        text: utterance.text,
        channelName: session.channel.name,
        userVoiceChannelId: session.channelId,
        userVoiceChannelName: session.channel.name,
        textChannelId: session.channelId,
        peoplePresent: session.presentMembers(),
        musicStatus: deps.music.describe(session.guildId),
        ambient: ambient.slice(-MAX_AMBIENT_SEGMENTS),
        followUp: turn.followUp,
        onText: (delta) => chunker.push(delta),
        signal: controller.signal,
      });
    } catch (error) {
      speech.cancel();
      if (controller.signal.aborted) return false; // told to stop
      if (error instanceof BudgetExceededError) return false;
      deps.logger.error(`Assistant failed to answer ${speakerName}: ${describeError(error)}`);
      await session.speak('Sorry, something went wrong on my end.');
      return false;
    }
    if (controller.signal.aborted) {
      speech.cancel();
      return false;
    }
    if (reply.silent) {
      speech.cancel();
      return false;
    }
    if (reply.outcome === 'refused') {
      // Anything said before the refusal is cut off; say the refusal instead.
      speech.cancel();
      speech = session.openReply();
      spoken.length = 0;
      spokenLength = 0;
      startedAt = undefined;
      say(reply.text);
    } else {
      chunker.flush();
      // Nothing streamed (e.g. the "got stuck" fallback): say the final text.
      if (spoken.length === 0) say(reply.text);
    }
    if (reply.sources.length > 0) {
      deps.logger.info(`Spoken reply used web sources: ${reply.sources.map((source) => source.url).join(', ')}`);
    }

    await speech.finished();
    if (spoken.length === 0) return false;
    const interrupted = speech.cancelled || controller.signal.aborted;
    await this.recordOwnLine(session, `${spoken.join(' ')}${interrupted ? ' [cut off]' : ''}`, startedAt ?? deps.clock());
    return !interrupted;
  }

  private async recordOwnLine(session: VoiceSession, text: string, startedAt: number): Promise<void> {
    const transcriptSessionId = session.transcriptSessionId;
    if (transcriptSessionId === undefined) return;
    await this.deps.transcripts.appendSegment({
      sessionId: transcriptSessionId,
      guildId: session.guildId,
      channelId: session.channelId,
      speakerId: this.deps.botUserId(),
      speakerName: this.deps.assistantName,
      isAssistant: true,
      text,
      startedAt,
      endedAt: this.deps.clock(),
    });
  }
}
