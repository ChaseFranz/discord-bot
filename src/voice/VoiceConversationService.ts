import { BudgetExceededError, type CallTurnReply, type CallTurnRequest } from '../assistant/Assistant.js';
import { CallConversation } from '../assistant/CallConversation.js';
import type { LineAddress } from '../assistant/prompts.js';
import type { BargeIn, FollowUps } from '../config/config.js';
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
import type { ReplySpeech } from './ReplySpeech.js';
import type { VoiceSession } from './VoiceSession.js';
import type { CallListener } from './VoiceSessionManager.js';

export interface VoiceConversationDeps {
  assistant: { respondInCall(request: CallTurnRequest): Promise<CallTurnReply> };
  transcripts: TranscriptRepository;
  music: {
    describe(guildId: string): string;
    status(guildId: string): MusicStatus;
    pause(guildId: string): unknown;
  };
  /** The guild's current voice session, if any (for announcements), and leaving the call when told to. */
  sessions: { get(guildId: string): VoiceSession | undefined; leave(guildId: string): Promise<boolean> };
  privacy: { level(guildId: string, userId: string): Promise<PrivacyLevel> };
  budget: { isPaused(guildId: string): boolean };
  wakeWord: KeywordDetector;
  logger: Logger;
  clock: Clock;
  assistantName: string;
  /** Discord user id of the bot, used as the speaker id for its own lines. */
  botUserId: () => string;
  timeZone: string;
  /**
   * Who may carry on without the wake word: 'askers' (the people just answered, for a few seconds
   * after the reply), 'everyone' (anyone in the call, for those seconds), or 'always' (anyone, at
   * any time: every line is put to Claude, which decides whether it's being spoken to).
   */
  followUps: FollowUps;
  /** How long after a reply people can carry on without the wake word; 0 turns that off. */
  followUpMs: number;
  /**
   * Whose voice makes the assistant pause mid-reply: 'askers' (the people it's answering),
   * 'everyone', or 'off' (it finishes, then turns to what was said meanwhile; "stop" still works).
   */
  bargeIn: BargeIn;
  /** How much someone must have said before their voice holds a reply back (shorter sounds are ignored). */
  bargeInMs: number;
  /** Say "one sec" to someone who asks for something while a reply to someone else is playing. */
  acknowledge: boolean;
  /** The capture's end-of-speech silence, for the timing log only. */
  silenceMs: number;
  /**
   * Short sound (48 kHz 16-bit stereo PCM) played when the assistant hears its name, so people know
   * it's thinking. Undefined means no sound.
   */
  wakeSound?: Buffer;
}

/** Someone with something said to the assistant that it hasn't answered yet. */
interface Asker {
  id: string;
  name: string;
  /** What they said to it, oldest first. */
  said: string[];
  /** When they stopped talking and when the transcript of that was ready (their latest line). */
  spokeUntil: number;
  transcribedAt: number;
}

/** One call to the model, from being sent until it has finished writing. */
interface Turn {
  askers: Map<string, Asker>;
  controller: AbortController;
  /** A tool has run: the turn may have done something, so it can't be thrown away and redone. */
  acted: boolean;
  /** It is being thrown away because more was said before anyone heard any of it. */
  restarting: boolean;
  /** Someone said "stop". */
  stopped: boolean;
  /** More was said after it could no longer be redone: whatever it says is held for the next turn to judge. */
  holdReply: boolean;
  /** It was started to decide what happens to a reply that is on hold. */
  decides: boolean;
  reply: Reply | undefined;
}

/** A reply as it is spoken: waiting for audio, playing, on hold, or over. */
interface Reply {
  askers: Map<string, Asker>;
  speech: ReplySpeech;
  /** When its first sentence was ready, and when people first heard it. */
  startedAt: number;
  audibleAt: number | undefined;
  pieces: number;
  length: number;
  /** Frozen until the next turn decides whether it carries on or is replaced. */
  onHold: boolean;
  wake: (() => void) | undefined;
  /** People whose voice held it back for nothing; their voice alone won't hold it again. */
  heldForNothing: Set<string>;
  /** People told "one sec" while it was playing. */
  acknowledged: Set<string>;
  /** Set when this reply is the goodbye to someone who told the assistant to leave: once it has been said, it goes. */
  goodbyeTo: string | undefined;
  over: boolean;
}

interface CallState {
  session: VoiceSession;
  transcriptSessionId: number;
  conversation: CallConversation;
  live: boolean;
  /** People waiting for an answer, in the order they first asked. */
  waiting: Map<string, Asker>;
  turn: Turn | undefined;
  reply: Reply | undefined;
  /** After a reply: who can carry on without the wake word, and until when. */
  window: { from: number; until: number; askers: Set<string> } | undefined;
  /** Why speech is frozen right now (someone is talking over it, or a decision is pending). */
  holds: Set<string>;
  /** People whose "stop" was acted on before they had finished saying it. */
  stoppedEarly: Set<string>;
  driving: boolean;
  acknowledgements: number;
}

/** The hold that freezes a reply until the next turn has decided what happens to it. */
const DECISION = 'decision';
const talking = (userId: string) => `talking:${userId}`;

/** Longest reply spoken aloud; anything longer stops at a sentence boundary. */
const MAX_SPOKEN_CHARACTERS = 2_500;
const ACKNOWLEDGEMENTS = [
  (name: string) => `Got you, ${name}, one sec.`,
  (name: string) => `One sec, ${name}.`,
  (name: string) => `Hang on, ${name}, I'll get to that.`,
];

/**
 * The assistant's side of a voice call. Everyone in the call shares one conversation, and the
 * assistant takes turns in it like any other participant:
 *
 *  - Every utterance is recorded (subject to the speaker's privacy choice) and added to the call's
 *    conversation. Lines that may be meant for the assistant are marked as such; Claude decides.
 *  - When nothing is going on, a request is answered at once.
 *  - More said before anyone has heard the reply: the turn is thrown away and redone with all of
 *    it, so two people asking at once get one answer, and someone who pauses mid-sentence is heard out.
 *  - Someone being answered talks over the reply: it freezes mid-word. Claude is shown what they
 *    said and how far the reply had got, and either replaces the rest or carries on.
 *  - Anyone else who asks meanwhile waits (with a short "one sec") and is answered next.
 *  - "Stop" silences everything immediately, without asking Claude.
 */
export class VoiceConversationService implements CallListener {
  private readonly calls = new Map<string, CallState>();

  constructor(private readonly deps: VoiceConversationDeps) {}

  // ---------------------------------------------------------------------------
  // What the voice session reports
  // ---------------------------------------------------------------------------

  readonly utterance = async (session: VoiceSession, utterance: CapturedUtterance): Promise<void> => {
    const { deps } = this;
    const { userId } = utterance;
    try {
      const transcriptSessionId = session.transcriptSessionId;
      if (transcriptSessionId === undefined) return;
      const member = await session.resolveMember(userId);
      if (member?.user.bot) return;
      const speakerName = member?.displayName ?? `user ${userId}`;
      // Re-checked here: someone may have opted out while they were still talking.
      const privacy = await deps.privacy.level(session.guildId, userId);
      if (privacy === 'off') return;
      if (session.transcriptSessionId !== transcriptSessionId) return;

      const state = this.state(session, transcriptSessionId);
      const withoutName = deps.wakeWord.stripKeyword(utterance.text);
      const named = withoutName !== undefined;
      const address = this.addressOf(state, utterance, named, privacy);
      const command = parseVoiceCommand(withoutName ?? utterance.text);

      // "Only when I'm talking to Nimbus": everything else is dropped unseen, unstored and unlogged.
      if (privacy === 'requests' && address === 'others') return;

      await deps.transcripts.appendSegment({
        sessionId: transcriptSessionId,
        guildId: session.guildId,
        channelId: session.channelId,
        speakerId: userId,
        speakerName,
        isAssistant: false,
        text: utterance.text,
        startedAt: utterance.startedAt,
        endedAt: utterance.endedAt,
      });
      deps.logger.debug(`[#${session.channel.name}] ${speakerName}: ${utterance.text}`);
      if (!state.live) return;

      // From here to the end there is no waiting: the line goes on record and is acted on in one
      // step, so nothing else can happen in between.
      const line = { speakerId: userId, speakerName, text: utterance.text, at: utterance.startedAt, address };
      const stoppedEarly = state.stoppedEarly.delete(userId);
      const budgetSpent = deps.budget.isPaused(session.guildId);
      if (address === 'others' || command === 'stop' || budgetSpent) {
        state.conversation.hear(line);
        if (address === 'others') return;
        // "Stop" may already have been acted on, while they were still saying it.
        if (command === 'stop') {
          if (!stoppedEarly) this.stopFor(state, speakerName);
        } else {
          deps.logger.info(`Not answering ${speakerName}: today's budget is used up.`);
        }
        return;
      }
      deps.logger.info(`${LOG_LABELS[address]} from ${speakerName} in #${session.channel.name}: "${utterance.text}"`);
      // If this puts a reply on hold, the note on how far it had got goes on record just before the line.
      this.holdForDecision(state, userId);
      state.conversation.hear(line);
      this.accept(state, { id: userId, name: speakerName, said: [utterance.text], spokeUntil: utterance.lastAudioAt, transcribedAt: utterance.endedAt }, named);
    } finally {
      // Whatever they said has been dealt with; their voice no longer holds anything back.
      this.doneTalking(session.guildId, userId, true);
    }
  };

  /** Someone is talking right now. If the assistant is answering them, it yields. */
  readonly speaking = (session: VoiceSession, userId: string, audioMs: number): void => {
    const state = this.calls.get(session.guildId);
    if (!state?.live || audioMs < this.deps.bargeInMs || state.holds.has(talking(userId))) return;
    const reply = state.reply;
    if (reply?.speech.audioStarted) {
      // Talking over a reply people can hear: it freezes, if this person may interrupt it.
      if (!this.mayInterrupt(reply, userId) || reply.heldForNothing.has(userId)) return;
    } else {
      // Nothing heard yet: someone being answered is still talking, so the reply waits for them.
      const askers = reply?.askers ?? state.turn?.askers;
      if (!askers?.has(userId)) return;
    }
    this.hold(state, talking(userId));
  };

  /** What someone has said so far. "Nimbus, stop" is acted on before they've finished the breath. */
  readonly partial = (session: VoiceSession, userId: string, text: string): void => {
    const state = this.calls.get(session.guildId);
    if (!state?.live || state.stoppedEarly.has(userId)) return;
    if (!state.turn && !state.reply) return;
    const withoutName = this.deps.wakeWord.stripKeyword(text);
    if (withoutName === undefined || parseVoiceCommand(withoutName) !== 'stop') return;
    state.stoppedEarly.add(userId);
    this.stopFor(state, session.channel.guild.members.cache.get(userId)?.displayName ?? `user ${userId}`);
  };

  readonly captureEnded = (session: VoiceSession, userId: string, heard: boolean): void => {
    // When something was heard, the utterance handler finishes up once it has dealt with it.
    if (!heard) this.doneTalking(session.guildId, userId, false);
  };

  // ---------------------------------------------------------------------------
  // Other entry points
  // ---------------------------------------------------------------------------

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
      this.calls.get(guildId)?.conversation.hear({
        speakerId: this.deps.botUserId(),
        speakerName: this.deps.assistantName,
        text: spoken,
        at: startedAt,
        address: 'announcement',
      });
      await this.recordOwnLine(session, spoken, startedAt);
    } finally {
      releaseMusic();
    }
    return true;
  }

  /** Forgets per-call state once the bot has left a guild's voice channel. */
  sessionEnded(guildId: string): void {
    const state = this.calls.get(guildId);
    if (!state) return;
    this.end(state);
    this.calls.delete(guildId);
  }

  // ---------------------------------------------------------------------------
  // Reading a line
  // ---------------------------------------------------------------------------

  private state(session: VoiceSession, transcriptSessionId: number): CallState {
    const existing = this.calls.get(session.guildId);
    if (existing && existing.transcriptSessionId === transcriptSessionId) return existing;
    // A new stretch of listening (joined, or moved channel) is a new conversation.
    if (existing) this.end(existing);
    const state: CallState = {
      session,
      transcriptSessionId,
      conversation: new CallConversation(this.deps.timeZone),
      live: true,
      waiting: new Map(),
      turn: undefined,
      reply: undefined,
      window: undefined,
      holds: new Set(),
      stoppedEarly: new Set(),
      driving: false,
      acknowledgements: 0,
    };
    this.calls.set(session.guildId, state);
    return state;
  }

  private end(state: CallState): void {
    state.live = false;
    state.turn?.controller.abort();
    state.waiting.clear();
    state.holds.clear();
  }

  /** How a line relates to the assistant, from what the bot can observe. Claude makes the real call. */
  private addressOf(state: CallState, utterance: CapturedUtterance, named: boolean, privacy: PrivacyLevel): LineAddress {
    if (named) return 'named';
    const { userId } = utterance;
    const { reply, turn, window } = state;
    const answering = (reply?.askers ?? turn?.askers)?.has(userId) === true;
    if (reply?.speech.audioStarted) {
      // Said over a reply that was playing: an interruption, if this person's voice counts as one.
      // (Someone who only shares what they say to the assistant counts only while it is answering them.)
      if (answering || (this.deps.bargeIn === 'everyone' && privacy !== 'requests')) return 'interrupting';
    } else if (answering) {
      return 'continuing';
    }
    const inWindow =
      window !== undefined &&
      this.deps.followUpMs > 0 &&
      utterance.startedAt >= window.from &&
      utterance.startedAt <= window.until &&
      (window.askers.has(userId) || (this.deps.followUps !== 'askers' && privacy !== 'requests'));
    if (inWindow) return 'maybe';
    if (this.deps.followUps === 'always' && privacy !== 'requests') return 'maybe';
    return 'others';
  }

  private mayInterrupt(reply: Reply, userId: string): boolean {
    if (this.deps.bargeIn === 'off') return false;
    return this.deps.bargeIn === 'everyone' || reply.askers.has(userId);
  }

  // ---------------------------------------------------------------------------
  // Deciding what a new request does to what is already going on
  // ---------------------------------------------------------------------------

  /**
   * Someone has said something to the assistant while it was already answering. Unless the turn can
   * simply be redone, or this person has to wait their turn, the reply is frozen where it is (or
   * kept from starting) until the next turn has decided what becomes of it, and a note says how
   * far it had got.
   */
  private holdForDecision(state: CallState, userId: string): void {
    const { turn, reply } = state;
    if (turn && this.canRedo(turn)) return; // it will be redone instead
    if (reply && !reply.onHold && (!reply.speech.audioStarted || this.mayInterrupt(reply, userId))) {
      this.hold(state, DECISION);
      reply.onHold = true;
      state.conversation.note(progressNote(reply));
      reply.wake?.();
    } else if (turn && !turn.reply && !turn.holdReply) {
      // It has acted but not spoken yet. Whatever it says waits for the next turn.
      this.hold(state, DECISION);
      turn.holdReply = true;
      state.conversation.note('Your reply to the last turn has not been spoken yet. It is on hold: more was said first.');
    }
  }

  /** A turn can be thrown away and redone while it has done nothing and nobody has heard any of it. */
  private canRedo(turn: Turn): boolean {
    return !turn.acted && !turn.stopped && turn.reply?.speech.audioStarted !== true;
  }

  private accept(state: CallState, asker: Asker, named: boolean): void {
    const { deps } = this;
    const { turn, reply } = state;
    merge(state.waiting, asker);

    if (turn && this.canRedo(turn) && !turn.holdReply) {
      // Nobody has heard any of it: start over with everything that has been said.
      turn.restarting = true;
      if (turn.reply) this.finish(state, turn.reply, 'cut');
      turn.controller.abort();
    } else if (reply && !reply.onHold && reply.speech.audioStarted && named && deps.acknowledge) {
      // Someone else is being answered. Let this person know they were heard.
      this.acknowledge(state, reply, asker);
    }
    if (named && deps.wakeSound) state.session.playEarcon(deps.wakeSound);
    void this.drive(state);
  }

  private acknowledge(state: CallState, reply: Reply, asker: Asker): void {
    if (reply.acknowledged.has(asker.id)) return;
    // Not worth it when the reply is on its last sentence: their answer is seconds away.
    if (reply.speech.progress().unsaid.length === 0 && state.turn?.reply !== reply) return;
    reply.acknowledged.add(asker.id);
    const text = ACKNOWLEDGEMENTS[state.acknowledgements++ % ACKNOWLEDGEMENTS.length]!(asker.name);
    const at = this.deps.clock();
    void state.session
      .interject(text)
      .then(async (said) => {
        // On record only if it was actually said: a "stop" may have got there first.
        if (!said || !state.live) return;
        state.conversation.hear({ speakerId: this.deps.botUserId(), speakerName: this.deps.assistantName, text, at, address: 'announcement' });
        await this.recordOwnLine(state.session, text, at);
      })
      .catch((error: unknown) => this.deps.logger.warn(`Could not record an acknowledgement: ${describeError(error)}`));
  }

  /** `userId` has stopped talking. If their voice was holding a reply back, it carries on. */
  private doneTalking(guildId: string, userId: string, heard: boolean): void {
    const state = this.calls.get(guildId);
    if (!state) return;
    if (!heard) state.stoppedEarly.delete(userId);
    const reply = state.reply;
    // Their voice froze the reply, and nothing came of it: their voice alone won't freeze it again.
    if (state.holds.has(talking(userId)) && reply && !reply.onHold) reply.heldForNothing.add(userId);
    this.release(state, talking(userId));
  }

  private hold(state: CallState, why: string): void {
    if (state.holds.has(why)) return;
    state.holds.add(why);
    if (state.holds.size === 1) state.session.pauseSpeaking();
  }

  private release(state: CallState, why: string): void {
    if (!state.holds.delete(why)) return;
    if (state.holds.size === 0 && state.live) state.session.resumeSpeaking();
  }

  // ---------------------------------------------------------------------------
  // Taking turns
  // ---------------------------------------------------------------------------

  /** Answers whoever is waiting, one turn after another, until nobody is. */
  private async drive(state: CallState): Promise<void> {
    if (state.driving) return;
    state.driving = true;
    // From the first request until the last reply has been spoken, music stays quiet.
    const releaseMusic = state.session.holdMusic();
    try {
      while (state.live && state.waiting.size > 0) {
        await this.takeTurn(state);
      }
    } catch (error) {
      this.deps.logger.error(`The conversation in guild ${state.session.guildId} hit a problem: ${describeError(error)}`);
    } finally {
      state.driving = false;
      // Nobody is left to decide about a reply still on hold, so it carries on.
      const stranded = state.reply?.onHold ? state.reply : undefined;
      if (stranded) stranded.onHold = false;
      this.release(state, DECISION);
      if (stranded && state.live) {
        void this.untilSpoken(stranded).then((outcome) => {
          if (outcome === 'spoken') this.finish(state, stranded, 'spoken');
        });
      }
      releaseMusic();
    }
  }

  private async takeTurn(state: CallState): Promise<void> {
    const { deps } = this;
    const { session } = state;
    const onHold = state.reply?.onHold ? state.reply : undefined;
    const turn: Turn = {
      askers: new Map(state.waiting),
      controller: new AbortController(),
      acted: false,
      restarting: false,
      stopped: false,
      holdReply: false,
      decides: state.holds.has(DECISION),
      reply: undefined,
    };
    state.waiting.clear();
    state.turn = turn;
    const latest = [...turn.askers.values()].at(-1)!;

    const say = (piece: string) => {
      const text = toSpeakableText(piece);
      if (text.length === 0 || turn.stopped || turn.restarting || !state.live) return;
      if (!turn.reply) {
        // The first words of this turn. A reply that was on hold is replaced by them.
        if (onHold && state.reply === onHold) this.finish(state, onHold, 'replaced');
        turn.reply = this.openReply(state, turn, latest);
        if (turn.holdReply) turn.reply.onHold = true;
        else if (turn.decides) this.release(state, DECISION);
      }
      const reply = turn.reply;
      if (reply.speech.cancelled || reply.length + text.length > MAX_SPOKEN_CHARACTERS) return;
      reply.pieces++;
      reply.length += text.length + 1;
      reply.speech.say(text);
    };
    const chunker = new SentenceChunker(say);

    let answer: CallTurnReply | undefined;
    let failed = false;
    try {
      answer = await deps.assistant.respondInCall({
        guildId: session.guildId,
        conversation: state.conversation,
        askers: [...turn.askers.values()].map((asker) => ({ id: asker.id, name: asker.name, said: asker.said.join(' ') })),
        channelId: session.channelId,
        channelName: session.channel.name,
        peoplePresent: session.presentMembers(),
        musicStatus: deps.music.describe(session.guildId),
        onText: (delta) => chunker.push(delta),
        onToolCall: () => {
          turn.acted = true;
        },
        signal: turn.controller.signal,
      });
    } catch (error) {
      if (state.turn === turn) state.turn = undefined;
      if (turn.restarting) {
        // Redo it with what these people said and whatever has been said since.
        state.waiting = mergeAll(turn.askers, state.waiting);
        return;
      }
      if (turn.stopped || !state.live) return;
      // Whatever it had started to say is cut off.
      if (turn.reply) {
        this.finish(state, turn.reply, 'cut');
        turn.reply = undefined;
      }
      if (!(error instanceof BudgetExceededError)) {
        failed = true;
        deps.logger.error(`Assistant failed to answer ${latest.name}: ${describeError(error)}`);
      }
    }
    if (state.turn === turn) state.turn = undefined;
    if (turn.stopped || !state.live) return;

    if (!answer) {
      // Nothing came of the turn.
    } else if (answer.stopped) {
      this.stopFor(state, undefined);
      return;
    } else if (answer.outcome === 'refused') {
      // Anything said before the refusal is cut off; say the refusal instead.
      if (turn.reply) {
        this.finish(state, turn.reply, 'cut');
        turn.reply = undefined;
      }
      say(answer.text);
    } else if (answer.silent) {
      if (turn.reply) {
        this.finish(state, turn.reply, 'cut');
        turn.reply = undefined;
      }
    } else {
      chunker.flush();
      // Nothing streamed (e.g. the "got stuck" fallback): say the final text.
      if (!turn.reply) say(answer.text);
    }
    if (answer && answer.sources.length > 0) {
      deps.logger.info(`Spoken reply used web sources: ${answer.sources.map((source) => source.url).join(', ')}`);
    }

    const reply = turn.reply ?? this.carryOn(state, turn, onHold);
    // Said after anything that was already on its way out.
    if (failed) void session.speak('Sorry, something went wrong on my end.');
    if (answer?.leave) {
      // Told to go. With a goodbye, it leaves once that has been said (see finish): if someone
      // talks over it, the next turn can still change its mind, and "stop" calls it off. With
      // nothing to say, it leaves now.
      if (turn.reply) {
        turn.reply.goodbyeTo = latest.name;
      } else {
        this.leave(state, latest.name);
        return;
      }
    }
    if (!reply) {
      if (answer && !onHold) deps.logger.info(`Stayed quiet: nothing in what ${latest.name} said needed a reply.`);
      return;
    }
    if ((await this.untilSpoken(reply)) === 'spoken') this.finish(state, reply, 'spoken');
  }

  /** Leaves the call because someone in it said to. */
  private leave(state: CallState, askedBy: string): void {
    const { deps } = this;
    const { guildId } = state.session;
    deps.logger.info(`Leaving the call: ${askedBy} said to.`);
    void deps.sessions.leave(guildId).catch((error: unknown) => deps.logger.warn(`Could not leave the call: ${describeError(error)}`));
  }

  /**
   * This turn had nothing (more) to say. A reply it was deciding about carries on from where it
   * froze, unless yet more has been said and the next turn has to decide again.
   */
  private carryOn(state: CallState, turn: Turn, onHold: Reply | undefined): Reply | undefined {
    if (turn.holdReply) return undefined;
    if (onHold && state.reply === onHold && !onHold.over) {
      onHold.onHold = false;
      // Whoever interrupted didn't change anything: their voice alone won't freeze this reply again.
      for (const asker of turn.askers.keys()) onHold.heldForNothing.add(asker);
      this.deps.logger.info(`Carrying on: what ${[...turn.askers.values()].map((asker) => asker.name).join(' and ')} said didn't change the reply.`);
    }
    if (turn.decides) this.release(state, DECISION);
    return onHold && state.reply === onHold && !onHold.over ? onHold : undefined;
  }

  private openReply(state: CallState, turn: Turn, latest: Asker): Reply {
    const { deps } = this;
    const speech = state.session.openReply();
    const reply: Reply = {
      askers: turn.askers,
      speech,
      startedAt: deps.clock(),
      audibleAt: undefined,
      pieces: 0,
      length: 0,
      onHold: false,
      wake: undefined,
      heldForNothing: new Set(),
      acknowledged: new Set(),
      goodbyeTo: undefined,
      over: false,
    };
    state.reply = reply;
    speech.onAudioStart(() => {
      reply.audibleAt = deps.clock();
      // From the end of what they said to the first sound of the answer, and where the time went.
      const total = reply.audibleAt - latest.spokeUntil;
      deps.logger.info(
        `Timing for ${latest.name}: ${total} ms from the end of their speech to the reply ` +
          `(transcript ${latest.transcribedAt - latest.spokeUntil} ms, of which ${deps.silenceMs} ms waiting out silence; ` +
          `first sentence ${reply.startedAt - latest.transcribedAt} ms; speech ${reply.audibleAt - reply.startedAt} ms).`,
      );
    });
    return reply;
  }

  /** Waits until the reply has been spoken, or has been put on hold for the next turn to decide about. */
  private async untilSpoken(reply: Reply): Promise<'spoken' | 'held'> {
    if (reply.onHold) return 'held';
    const held = new Promise<'held'>((resolve) => {
      reply.wake = () => resolve('held');
    });
    const outcome = await Promise.race([reply.speech.finished().then(() => 'spoken' as const), held]);
    reply.wake = undefined;
    return reply.onHold && !reply.over ? 'held' : outcome;
  }

  /** The reply is over: record what was heard of it, and open the floor if all of it was. */
  private finish(state: CallState, reply: Reply, how: 'spoken' | 'cut' | 'replaced'): void {
    if (reply.over) return;
    reply.over = true;
    reply.onHold = false;
    if (how !== 'spoken') reply.speech.cancel();
    reply.wake?.();
    if (state.reply === reply) state.reply = undefined;
    const { heard, interrupted } = reply.speech.progress();
    const said = interrupted === undefined ? heard : [...heard, interrupted];
    const complete = how === 'spoken' && heard.length === reply.pieces;
    if (said.length > 0) {
      void this.recordOwnLine(state.session, `${said.join(' ')}${complete ? '' : ' [cut off]'}`, reply.startedAt).catch((error: unknown) =>
        this.deps.logger.warn(`Could not record a spoken reply: ${describeError(error)}`),
      );
    }
    if (complete && this.deps.followUpMs > 0 && state.live) {
      const now = this.deps.clock();
      // Open from when the reply became audible: people often start answering just before it ends.
      state.window = { from: reply.audibleAt ?? now, until: now + this.deps.followUpMs, askers: new Set(reply.askers.keys()) };
    }
    // That was its goodbye.
    if (how === 'spoken' && reply.goodbyeTo !== undefined && state.live) this.leave(state, reply.goodbyeTo);
  }

  // ---------------------------------------------------------------------------
  // Stop
  // ---------------------------------------------------------------------------

  /** "Stop": silence everything at once. `speakerName` is undefined when Claude judged it had been told to. */
  private stopFor(state: CallState, speakerName: string | undefined): void {
    const { deps } = this;
    const { session, turn, reply } = state;
    const interrupted = turn !== undefined || reply !== undefined;
    if (turn) {
      turn.stopped = true;
      turn.controller.abort();
    }
    state.turn = undefined;
    state.waiting.clear();
    state.window = undefined;
    state.holds.clear();
    const who = speakerName ?? 'Someone';
    if (reply) {
      const { heard, interrupted: partway } = reply.speech.progress();
      const said = partway === undefined ? heard : [...heard, partway];
      state.conversation.note(
        said.length > 0
          ? `${who} told you to stop. Of your reply, only this was heard: "${said.join(' ')}"`
          : `${who} told you to stop before any of your reply had been spoken.`,
      );
      this.finish(state, reply, 'cut');
    } else if (turn) {
      state.conversation.note(`${who} told you to stop before you had answered.`);
    }
    const wasSpeaking = session.stopSpeaking();
    if (wasSpeaking || interrupted) {
      deps.logger.info(`${who} told ${deps.assistantName} to stop.`);
      return;
    }
    // Nothing to interrupt: like a smart speaker, "stop" then means the music (paused, so "resume" works).
    if (deps.music.status(session.guildId).state !== 'playing') return;
    try {
      deps.music.pause(session.guildId);
      deps.logger.info(`${who} said stop; paused the music.`);
    } catch (error) {
      if (!(error instanceof MusicError)) throw error;
    }
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

const LOG_LABELS: Record<LineAddress, string> = {
  named: 'Wake word',
  continuing: 'More',
  maybe: 'Possible follow-up',
  interrupting: 'Interruption',
  others: 'Background',
  announcement: 'Announcement',
};

/** Adds an asker to those waiting, joining what they said to anything they were already waiting on. */
function merge(waiting: Map<string, Asker>, asker: Asker): void {
  const existing = waiting.get(asker.id);
  if (!existing) {
    waiting.set(asker.id, { ...asker, said: [...asker.said] });
    return;
  }
  // Moved to the end: the person who spoke last is the one tools act for by default.
  waiting.delete(asker.id);
  waiting.set(asker.id, { ...asker, said: [...existing.said, ...asker.said] });
}

/** `earlier` askers followed by `later` ones, as one waiting list. */
function mergeAll(earlier: Map<string, Asker>, later: Map<string, Asker>): Map<string, Asker> {
  const all = new Map<string, Asker>();
  for (const asker of earlier.values()) merge(all, asker);
  for (const asker of later.values()) merge(all, asker);
  return all;
}

/** Tells the model how far a reply had got when it was put on hold. */
function progressNote(reply: Reply): string {
  const { heard, interrupted, unsaid } = reply.speech.progress();
  if (heard.length === 0 && interrupted === undefined) {
    return `None of your last reply has been spoken yet. It is on hold: more was said first. Still to say: "${unsaid.join(' ')}"`;
  }
  const parts = ['You were interrupted while speaking.'];
  if (heard.length > 0) parts.push(`Heard so far: "${heard.join(' ')}"`);
  if (interrupted !== undefined) parts.push(`You were part-way through: "${interrupted}"`);
  parts.push(unsaid.length > 0 ? `Not yet said: "${unsaid.join(' ')}"` : 'Nothing else was left to say.');
  return parts.join(' ');
}
