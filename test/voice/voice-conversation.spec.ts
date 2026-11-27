import type { CallTurnReply, CallTurnRequest } from '../../src/assistant/Assistant.js';
import { BudgetExceededError } from '../../src/assistant/Assistant.js';
import type { CallMark } from '../../src/assistant/CallConversation.js';
import type { MusicStatus } from '../../src/music/types.js';
import type { ConversationMessage, PrivacyLevel } from '../../src/storage/ports.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/sqlite/database.js';
import { SqliteTranscriptRepository } from '../../src/storage/sqlite/SqliteTranscriptRepository.js';
import { KeywordDetector } from '../../src/voice/keywordDetection.js';
import { openReplySpeech } from '../../src/voice/ReplySpeech.js';
import { SpeechQueue, type AudioSink } from '../../src/voice/SpeechQueue.js';
import { VoiceConversationService, type VoiceConversationDeps } from '../../src/voice/VoiceConversationService.js';
import type { VoiceSession } from '../../src/voice/VoiceSession.js';
import { fakeClock, settle, silentLogger } from '../helpers.js';

/** Audio here is just the text. A clip plays until the test ends it (or it's stopped). */
class FakeSink implements AudioSink<string> {
  readonly events: string[] = [];
  playing: string | undefined;
  private end: (() => void) | undefined;

  play(audio: string): Promise<void> {
    this.events.push(`play: ${audio}`);
    this.playing = audio;
    return new Promise((resolve) => {
      this.end = () => {
        this.playing = undefined;
        resolve();
      };
    });
  }
  stop(): void {
    this.events.push('stop');
    this.finish();
  }
  discard(): void {}
  pause(): void {
    this.events.push('pause');
  }
  resume(): void {
    this.events.push('resume');
  }
  /** The clip that is playing reaches its end. */
  finish(): void {
    const end = this.end;
    this.end = undefined;
    end?.();
  }
}

/** What the stand-in for Claude does with one turn. `mark` is what the turn had heard when it was sent. */
type Script = (request: CallTurnRequest, mark: CallMark) => Promise<CallTurnReply>;

const answer = (text: string, extra: Partial<CallTurnReply> = {}): CallTurnReply => ({
  text, silent: false, stopped: false, leave: false, outcome: 'answered', sources: [], model: 'claude-haiku-5-5', ...extra,
});
const spoken = (text: string): ConversationMessage[] => [{ role: 'assistant', content: [{ type: 'text', text }] }];
const toolCall = (name: string): ConversationMessage[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id: `tu_${name}`, name, input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${name}`, content: 'ok' }] },
];
const whenAborted = (signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));

/** Writes a reply, piece by piece, and records it in the conversation as the real assistant does. */
const says = (...pieces: string[]): Script => async (request, mark) => {
  for (const piece of pieces) request.onText?.(piece);
  request.signal?.throwIfAborted();
  request.conversation.reply(mark, spoken(pieces.join('')));
  return answer(pieces.join(''));
};
const staysQuiet = (): Script => async (request, mark) => {
  request.conversation.reply(mark, toolCall('say_nothing'));
  return answer('', { silent: true });
};
const saysItWasToldToStop = (): Script => async (request, mark) => {
  request.conversation.reply(mark, toolCall('stop_speaking'));
  return answer('', { silent: true, stopped: true });
};
/** Told to leave: it calls leave_call, then says goodbye (or nothing). */
const saysGoodbyeAndLeaves = (...pieces: string[]): Script => async (request, mark) => {
  request.onToolCall?.('leave_call');
  for (const piece of pieces) request.onText?.(piece);
  request.signal?.throwIfAborted();
  request.conversation.reply(mark, [...toolCall('leave_call'), ...(pieces.length > 0 ? spoken(pieces.join('')) : [])]);
  return answer(pieces.join(''), { leave: true });
};
const refuses = (...before: string[]): Script => async (request) => {
  for (const piece of before) request.onText?.(piece);
  return answer("Sorry, I can't help with that one.", { outcome: 'refused' });
};
const fails = (error: Error = new Error('boom')): Script => async () => {
  throw error;
};
/** A turn that waits until the test opens the gate (or the turn is aborted), optionally having run a tool first. */
function gated(then: Script, options: { acts?: boolean } = {}): { script: Script; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const script: Script = async (request, mark) => {
    if (options.acts) request.onToolCall?.('set_reminder');
    await Promise.race([gate, whenAborted(request.signal)]);
    request.signal?.throwIfAborted();
    return then(request, mark);
  };
  return { script, open };
}

describe('VoiceConversationService', () => {
  let db: SqliteDatabase;
  let transcripts: SqliteTranscriptRepository;
  /** Every turn sent to the assistant: who it was for, what it was shown last, and whether it was aborted. */
  let turns: Array<{ askers: string[]; saw: string; signal: AbortSignal | undefined }>;
  let scripts: Script[];
  /** Order of what the session and assistant were asked to do, outside of audio (see sink.events for that). */
  let events: string[];
  let logged: string[];
  let privacy: Record<string, PrivacyLevel>;
  let paused: boolean;
  let musicState: MusicStatus['state'];
  let sink: FakeSink;
  /** When set, text-to-speech isn't ready until it resolves (audio can't start before then). */
  let synthesis: Promise<void> | undefined;
  let session: VoiceSession;
  let deps: VoiceConversationDeps;
  let service: VoiceConversationService;
  const clock = fakeClock();

  const members: Record<string, { displayName: string; user: { bot: boolean } }> = {
    'u-alice': { displayName: 'Alice', user: { bot: false } },
    'u-sam': { displayName: 'Sam', user: { bot: false } },
    'u-cara': { displayName: 'Cara', user: { bot: false } },
    'u-bot': { displayName: 'OtherBot', user: { bot: true } },
  };

  function makeSession(transcriptSessionId: number): VoiceSession {
    sink = new FakeSink();
    const queue = new SpeechQueue<string>(sink, { started: () => undefined, idle: () => undefined }, silentLogger());
    return {
      guildId: 'g',
      channelId: 'vc',
      channel: { name: 'General', guild: { members: { cache: new Map(Object.entries(members)) } } },
      transcriptSessionId,
      presentMembers: () => [{ id: 'u-alice', name: 'Alice' }, { id: 'u-cara', name: 'Cara' }, { id: 'u-sam', name: 'Sam' }],
      resolveMember: async (id: string) => members[id],
      speak: (text: string) => queue.enqueue('a reply', async () => text),
      openReply: () =>
        openReplySpeech(queue, async (text) => {
          await synthesis;
          return text;
        }),
      stopSpeaking: () => queue.stopAll(),
      pauseSpeaking: () => queue.pause(),
      resumeSpeaking: () => queue.resume(),
      get speechPaused() {
        return queue.paused;
      },
      interject: async (text: string) => {
        let said = false;
        await queue.enqueueNext('an acknowledgement', async () => text, { started: () => void (said = true) });
        return said;
      },
      holdMusic: () => {
        events.push('hold music');
        return () => events.push('release music');
      },
      playEarcon: () => {
        if (queue.busy) return false;
        void queue.enqueue('a sound', async () => '*chime*');
        return true;
      },
    } as unknown as VoiceSession;
  }

  function start(overrides: Partial<VoiceConversationDeps> = {}): void {
    deps = {
      assistant: {
        respondInCall: async (request) => {
          const mark = request.conversation.mark();
          const last = request.conversation.messages(mark).at(-1)!;
          turns.push({
            askers: request.askers.map((asker) => `${asker.name}: ${asker.said}`),
            saw: (last.content as Array<{ text?: string }>).map((block) => block.text ?? '').join('\n'),
            signal: request.signal,
          });
          events.push('think');
          return (scripts.shift() ?? says('Okay.'))(request, mark);
        },
      },
      transcripts,
      music: {
        describe: () => 'nothing playing',
        status: () => ({ state: musicState, current: undefined, upcoming: [] }),
        pause: () => events.push('pause music'),
      },
      sessions: {
        get: (guildId: string) => (guildId === 'g' ? session : undefined),
        leave: async (guildId: string) => (events.push(`leave ${guildId}`), true),
      },
      privacy: { level: async (_guildId: string, userId: string) => privacy[userId] ?? 'full' },
      budget: { isPaused: () => paused },
      wakeWord: new KeywordDetector('nimbus'),
      logger: Object.assign(silentLogger(), { info: (message: string) => void logged.push(message) }) as VoiceConversationDeps['logger'],
      clock,
      assistantName: 'Nimbus',
      botUserId: () => 'u-nimbus',
      timeZone: 'UTC',
      followUps: 'everyone',
      followUpMs: 8_000,
      bargeIn: 'askers',
      bargeInMs: 500,
      acknowledge: true,
      silenceMs: 600,
      ...overrides,
    };
    service = new VoiceConversationService(deps);
  }

  beforeEach(async () => {
    db = openDatabase(':memory:');
    transcripts = new SqliteTranscriptRepository(db);
    turns = [];
    scripts = [];
    events = [];
    logged = [];
    privacy = {};
    paused = false;
    musicState = 'idle';
    synthesis = undefined;
    clock.set(Date.UTC(2026, 10, 26, 19, 0, 0));
    const record = await transcripts.startSession({ guildId: 'g', channelId: 'vc', channelName: 'General', startedAt: clock() });
    session = makeSession(record.id);
    start();
  });
  afterEach(() => db.close());

  /** Someone finishes saying `text`, `afterMs` after the last thing that happened. It took them a second to say. */
  const hears = async (userId: string, text: string, afterMs = 2_000) => {
    clock.advance(afterMs);
    const endedAt = clock();
    await service.utterance(session, { userId, text, startedAt: endedAt - 1_000, lastAudioAt: endedAt - 700, endedAt });
    await settle();
  };
  /** Someone has been talking for `audioMs` of their current utterance. */
  const talks = (userId: string, audioMs = 600) => service.speaking(session, userId, audioMs);
  /** Whatever is playing reaches its end; then the next clip (if any) starts. */
  const clipEnds = async (times = 1) => {
    for (let index = 0; index < times; index++) {
      sink.finish();
      await settle();
    }
  };
  const played = () => sink.events.filter((event) => event.startsWith('play: ')).map((event) => event.slice(6));
  const lines = async () =>
    (await transcripts.readRange({ guildId: 'g', limit: 50, order: 'oldest_first' })).segments.map(
      (s) => `${s.isAssistant ? '*' : ''}${s.speakerName}: ${s.text}`,
    );

  // ---------------------------------------------------------------------------

  describe('the basics', () => {
    it('records everything, shows Claude the whole conversation, and answers only what is said to it', async () => {
      await hears('u-sam', 'pizza tonight?');
      expect(turns).toHaveLength(0);
      scripts.push(says('Sure, **pizza** it is!'));
      await hears('u-alice', 'Nimbus, what should we eat?');

      expect(turns).toEqual([
        {
          askers: ['Alice: Nimbus, what should we eat?'],
          saw: '<call_lines>\n[19:00:01] Sam: pizza tonight?\n[19:00:03] Alice (to you): Nimbus, what should we eat?\n</call_lines>',
          signal: expect.anything(),
        },
      ]);
      // Markdown is stripped before it is spoken.
      expect(played()).toEqual(['Sure, pizza it is!']);
      await clipEnds();
      expect(await lines()).toEqual(['Sam: pizza tonight?', 'Alice: Nimbus, what should we eat?', '*Nimbus: Sure, pizza it is!']);
    });

    it('starts on a request at once when nothing else is going on', async () => {
      const turn = gated(says('Hi.'));
      scripts.push(turn.script);
      clock.advance(1_000);
      const at = clock();
      await service.utterance(session, { userId: 'u-alice', text: 'Nimbus, hi', startedAt: at - 800, lastAudioAt: at - 600, endedAt: at });
      // No timers, no waiting for more: the turn is already with Claude.
      expect(turns).toHaveLength(1);
      turn.open();
      await settle();
      expect(played()).toEqual(['Hi.']);
    });

    it('speaks each sentence as soon as it has been written', async () => {
      const rest = gated(says(' one is longer. And here is more.'));
      scripts.push(async (request, mark) => {
        request.onText?.('First sentence. Second');
        return rest.script(request, mark);
      });
      await hears('u-alice', 'Nimbus, go');
      // The first sentence is already playing while the rest is still being written.
      expect(played()).toEqual(['First sentence.']);
      rest.open();
      await settle();
      await clipEnds(3);
      expect(played()).toEqual(['First sentence.', 'Second one is longer.', 'And here is more.']);
    });

    it('keeps music quiet from the request until the reply has been spoken, and chimes when it hears its name', async () => {
      start({ wakeSound: Buffer.alloc(16) });
      scripts.push(says('On it.'));
      await hears('u-alice', 'Nimbus, hello');
      expect(events).toEqual(['hold music', 'think']);
      expect(played()).toEqual(['*chime*']);
      await clipEnds();
      expect(played()).toEqual(['*chime*', 'On it.']);
      expect(events).not.toContain('release music');
      await clipEnds();
      expect(events).toEqual(['hold music', 'think', 'release music']);
    });

    it('says the refusal in place of anything it had started to say', async () => {
      scripts.push(refuses('Well, first you take. '));
      await hears('u-alice', 'Nimbus, something it declines');
      await clipEnds(3);
      expect(played().at(-1)).toBe("Sorry, I can't help with that one.");
      expect((await lines()).at(-1)).toBe("*Nimbus: Sorry, I can't help with that one.");
    });

    it('apologises out loud if the assistant fails', async () => {
      scripts.push(fails());
      await hears('u-alice', 'Nimbus, hello');
      expect(played()).toEqual(['Sorry, something went wrong on my end.']);
      await clipEnds();
      expect(events.at(-1)).toBe('release music');
    });

    it('ignores other bots', async () => {
      await hears('u-bot', 'Nimbus, hello');
      expect(turns).toHaveLength(0);
      expect(await lines()).toEqual([]);
    });

    it('announces things in the call, and tells Claude it did', async () => {
      await hears('u-sam', 'hello all');
      const announced = service.announce('g', 'Reminder for **Alice**: stretch.');
      await settle();
      expect(played()).toEqual(['Reminder for Alice: stretch.']);
      await clipEnds();
      expect(await announced).toBe(true);
      expect(await service.announce('elsewhere', 'hello')).toBe(false);
      expect(await lines()).toEqual(['Sam: hello all', '*Nimbus: Reminder for Alice: stretch.']);

      await hears('u-alice', 'Nimbus, what was that?');
      expect(turns[0]!.saw).toContain('Nimbus (you, announcing): Reminder for Alice: stretch.');
    });

    it('logs where the time went between the end of their speech and the reply', async () => {
      scripts.push(says('Hi there.'));
      await hears('u-alice', 'Nimbus, hi');
      expect(logged.find((message) => message.startsWith('Timing for Alice'))).toBe(
        'Timing for Alice: 700 ms from the end of their speech to the reply ' +
          '(transcript 700 ms, of which 600 ms waiting out silence; first sentence 0 ms; speech 0 ms).',
      );
    });
  });

  // ---------------------------------------------------------------------------

  describe('more is said before anyone has heard the reply', () => {
    it('answers two people who ask at almost the same moment with one reply', async () => {
      const first = gated(says('Only for Alice.'));
      scripts.push(first.script, says('Alice, Paris. Sam, Madrid.'));
      await hears('u-alice', 'Nimbus, the capital of France?');
      await hears('u-sam', 'Nimbus, and of Spain?', 300);

      // The first turn was thrown away; the second answers both.
      expect(turns).toHaveLength(2);
      expect(turns[0]!.signal!.aborted).toBe(true);
      expect(turns[1]!.askers).toEqual(['Alice: Nimbus, the capital of France?', 'Sam: Nimbus, and of Spain?']);
      expect(turns[1]!.saw).toContain('Alice (to you): Nimbus, the capital of France?');
      expect(turns[1]!.saw).toContain('Sam (to you): Nimbus, and of Spain?');
      expect(played()).toEqual(['Alice, Paris.']);
      await clipEnds(2);
      expect(played()).toEqual(['Alice, Paris.', 'Sam, Madrid.']);
      expect((await lines()).filter((line) => line.startsWith('*'))).toEqual(['*Nimbus: Alice, Paris. Sam, Madrid.']);
    });

    it('hears someone out when they pause mid-sentence and then carry on', async () => {
      const first = gated(says('The weather where?'));
      scripts.push(first.script, says('Sunny in Chicago tomorrow.'));
      await hears('u-alice', "Nimbus, what's the weather");
      talks('u-alice');
      await hears('u-alice', 'in Chicago tomorrow', 400);

      expect(turns).toHaveLength(2);
      expect(turns[0]!.signal!.aborted).toBe(true);
      expect(turns[1]!.askers).toEqual(["Alice: Nimbus, what's the weather in Chicago tomorrow"]);
      expect(turns[1]!.saw).toContain('Alice (to you, carrying on): in Chicago tomorrow');
      expect(played()).toEqual(['Sunny in Chicago tomorrow.']);
      // Nothing was held up for it: no pause or resume ever reached the speaker.
      expect(sink.events).toEqual(['play: Sunny in Chicago tomorrow.']);
    });

    it('holds a reply that is ready while the person it is for is still talking', async () => {
      scripts.push(says('The weather where?'));
      talks('u-alice'); // nothing to hold yet: nobody is being answered
      await hears('u-alice', "Nimbus, what's the weather");
      expect(played()).toEqual(['The weather where?']);
      await clipEnds();

      // This time they keep talking while the reply is on its way.
      const reply = gated(says('It depends where.'));
      scripts.push(reply.script, says('Sunny in Chicago.'));
      await hears('u-alice', "Nimbus, what's the weather");
      talks('u-alice');
      reply.open();
      await settle();
      // Written, but not spoken over them.
      expect(played()).toEqual(['The weather where?']);
      await hears('u-alice', 'in Chicago, I mean', 400);

      expect(turns).toHaveLength(3);
      expect(turns[2]!.saw).toContain('<bot_note>None of your last reply has been spoken yet. It is on hold: more was said first. Still to say: "It depends where."</bot_note>');
      expect(turns[2]!.saw).toContain('Alice (to you, carrying on): in Chicago, I mean');
      // The reply nobody heard is dropped for the new one.
      expect(played()).toEqual(['The weather where?', 'Sunny in Chicago.']);
      await clipEnds();
      expect((await lines()).filter((line) => line.startsWith('*'))).toEqual(['*Nimbus: The weather where?', '*Nimbus: Sunny in Chicago.']);
    });

    it('speaks the held reply after all if what they added changes nothing', async () => {
      const reply = gated(says('It is seven.'));
      scripts.push(reply.script, staysQuiet());
      await hears('u-alice', 'Nimbus, what time is it');
      talks('u-alice');
      reply.open();
      await settle();
      expect(played()).toEqual([]);
      await hears('u-alice', 'if you know', 400);
      expect(played()).toEqual(['It is seven.']);
      await clipEnds();
      expect((await lines()).at(-1)).toBe('*Nimbus: It is seven.');
    });

    it('throws the turn away even if its first sentence was already on its way to the speaker', async () => {
      let ready!: () => void;
      synthesis = new Promise<void>((resolve) => (ready = resolve));
      const rest = gated(says(' More about Paris.'));
      scripts.push(async (request, mark) => {
        request.onText?.('Alice, Paris is the capital. And');
        return rest.script(request, mark);
      }, says('Alice, Paris. Sam, Madrid.'));
      await hears('u-alice', 'Nimbus, the capital of France?');
      await hears('u-sam', 'Nimbus, and of Spain?', 300);
      ready();
      await settle();
      await clipEnds(2);

      expect(turns).toHaveLength(2);
      expect(turns[0]!.signal!.aborted).toBe(true);
      // Nobody ever hears the sentence written for Alice alone.
      expect(played()).toEqual(['Alice, Paris.', 'Sam, Madrid.']);
      expect((await lines()).filter((line) => line.startsWith('*'))).toEqual(['*Nimbus: Alice, Paris. Sam, Madrid.']);
    });

    it("doesn't throw away a turn that has already done something", async () => {
      const first = gated(says('Timer set for ten minutes.'), { acts: true });
      scripts.push(first.script, says('Alice, your timer is set. Sam, it is seven.'));
      await hears('u-alice', 'Nimbus, set a timer for ten minutes');
      await hears('u-sam', 'Nimbus, what time is it?', 300);

      // The first turn carries on (its timer is real); what it says waits for the next turn.
      expect(turns).toHaveLength(1);
      expect(turns[0]!.signal!.aborted).toBe(false);
      first.open();
      await settle();
      expect(turns).toHaveLength(2);
      expect(turns[1]!.askers).toEqual(['Sam: Nimbus, what time is it?']);
      expect(turns[1]!.saw).toContain('<bot_note>Your reply to the last turn has not been spoken yet. It is on hold: more was said first.</bot_note>');
      expect(played()).toEqual(['Alice, your timer is set.']);
      await clipEnds(2);
      expect(played()).toEqual(['Alice, your timer is set.', 'Sam, it is seven.']);
      expect(sink.events).not.toContain('play: Timer set for ten minutes.');
    });
  });

  // ---------------------------------------------------------------------------

  describe('someone it is answering talks over the reply', () => {
    /** Alice asks; a three-sentence reply is playing its second sentence. */
    const midReply = async () => {
      scripts.push(says('It opens at nine on Sunday. ', 'Parking is free there. ', 'Bring a jacket though.'));
      await hears('u-alice', 'Nimbus, when does the market open?');
      await clipEnds();
      expect(sink.playing).toBe('Parking is free there.');
    };

    it('freezes mid-word, shows Claude how far it had got, and speaks the correction in its place', async () => {
      await midReply();
      talks('u-alice', 300); // too short to count: a cough, a click
      expect(sink.events).not.toContain('pause');
      talks('u-alice', 600);
      expect(sink.events.at(-1)).toBe('pause');

      scripts.push(says('Oh, Saturday? Then it opens at eight.'));
      await hears('u-alice', 'no, I meant Saturday');
      expect(turns[1]!.askers).toEqual(['Alice: no, I meant Saturday']);
      expect(turns[1]!.saw).toBe(
        '<bot_note>You were interrupted while speaking. Heard so far: "It opens at nine on Sunday." ' +
          'You were part-way through: "Parking is free there." Not yet said: "Bring a jacket though."</bot_note>\n' +
          '<call_lines>\n[19:00:03] Alice (while you were talking): no, I meant Saturday\n</call_lines>',
      );
      // The rest of the old reply is dropped; the new words carry on from the correction.
      expect(sink.events).toEqual([
        'play: It opens at nine on Sunday.',
        'play: Parking is free there.',
        'pause',
        'stop',
        'resume',
        'play: Oh, Saturday?',
      ]);
      await clipEnds(2);
      expect((await lines()).filter((line) => line.startsWith('*'))).toEqual([
        '*Nimbus: It opens at nine on Sunday. Parking is free there. [cut off]',
        '*Nimbus: Oh, Saturday? Then it opens at eight.',
      ]);
    });

    it('carries on from where it stopped when what they said changes nothing', async () => {
      await midReply();
      talks('u-alice');
      scripts.push(staysQuiet());
      await hears('u-alice', 'mm-hm, okay', 1_000);
      expect(sink.events.slice(-2)).toEqual(['pause', 'resume']);
      expect(logged).toContain("Carrying on: what Alice said didn't change the reply.");

      // Having held it up for nothing once, their voice alone won't freeze this reply again.
      talks('u-alice', 900);
      expect(sink.events.at(-1)).toBe('resume');
      await clipEnds(2);
      expect(played()).toEqual(['It opens at nine on Sunday.', 'Parking is free there.', 'Bring a jacket though.']);
      expect((await lines()).at(-1)).toBe('*Nimbus: It opens at nine on Sunday. Parking is free there. Bring a jacket though.');
    });

    it('still takes a correction from them after that, once they have said it', async () => {
      await midReply();
      talks('u-alice');
      scripts.push(staysQuiet(), says('Right, Saturday at eight.'));
      await hears('u-alice', 'uh huh', 1_000);
      await hears('u-alice', 'wait, Saturday not Sunday', 1_500);
      expect(turns[2]!.saw).toContain('Alice (while you were talking): wait, Saturday not Sunday');
      expect(played().at(-1)).toBe('Right, Saturday at eight.');
    });

    it('carries on when the sound turns out to be nothing', async () => {
      await midReply();
      talks('u-alice');
      service.captureEnded(session, 'u-alice', false);
      expect(sink.events.slice(-2)).toEqual(['pause', 'resume']);
      expect(turns).toHaveLength(1);
      talks('u-alice', 900);
      expect(sink.events.at(-1)).toBe('resume');
    });

    it("doesn't freeze for other people, but answers them next", async () => {
      await midReply();
      talks('u-sam', 2_000);
      expect(sink.events).not.toContain('pause');
      await hears('u-sam', 'this market is great by the way');
      expect(turns).toHaveLength(1);
    });

    it("lets anyone's voice freeze it when that is turned on, and no one's when it is off", async () => {
      start({ bargeIn: 'everyone' });
      await midReply();
      talks('u-sam');
      expect(sink.events.at(-1)).toBe('pause');
      scripts.push(staysQuiet());
      await hears('u-sam', 'which market is this?', 1_000);
      expect(turns[1]!.saw).toContain('Sam (while you were talking): which market is this?');
      expect(sink.events.at(-1)).toBe('resume');
      await clipEnds(2);

      start({ bargeIn: 'off' });
      session = makeSession(session.transcriptSessionId!);
      await midReply();
      talks('u-alice', 2_000);
      expect(sink.events).not.toContain('pause');
      // What they said waits until the reply is over.
      scripts.push(says('Saturday at eight.'));
      await hears('u-alice', 'I meant Saturday', 1_000);
      expect(played()).toEqual(['It opens at nine on Sunday.', 'Parking is free there.']);
      await clipEnds(2);
      expect(played().at(-1)).toBe('Saturday at eight.');
    });

    it('redoes the decision when a third person speaks before it has been made', async () => {
      await midReply();
      talks('u-alice');
      const deciding = gated(says('Only about Saturday.'));
      scripts.push(deciding.script, says('Oh, Saturday? Eight. Sam, yes, it is free.'));
      await hears('u-alice', 'no, I meant Saturday', 1_000);
      await hears('u-sam', 'Nimbus, is parking free?', 300);

      expect(turns).toHaveLength(3);
      expect(turns[1]!.signal!.aborted).toBe(true);
      expect(turns[2]!.askers).toEqual(['Alice: no, I meant Saturday', 'Sam: Nimbus, is parking free?']);
      // The old reply stayed frozen throughout, and is replaced only once.
      expect(sink.events.filter((event) => !event.startsWith('play: '))).toEqual(['pause', 'stop', 'resume']);
      expect(played().at(-1)).toBe('Oh, Saturday?');
    });

    it('carries on with the reply, then apologises, if deciding fails', async () => {
      await midReply();
      talks('u-alice');
      scripts.push(fails());
      await hears('u-alice', 'no, I meant Saturday', 1_000);
      expect(sink.events.slice(-2)).toEqual(['pause', 'resume']);
      await clipEnds(3);
      expect(played()).toEqual([
        'It opens at nine on Sunday.',
        'Parking is free there.',
        'Bring a jacket though.',
        'Sorry, something went wrong on my end.',
      ]);
    });

    it('waits for a reply that is still being written before deciding', async () => {
      // The first sentence is out; the rest is still being written when Alice cuts in.
      const whole = 'It opens at nine on Sunday. Parking is free there. Bring a jacket.';
      const rest = gated(async (request, mark) => {
        request.onText?.(' Bring a jacket.');
        request.conversation.reply(mark, spoken(whole));
        return answer(whole);
      });
      scripts.push(async (request, mark) => {
        request.onText?.('It opens at nine on Sunday. Parking is free there.');
        return rest.script(request, mark);
      }, says('Oh, Saturday? Eight.'));
      await hears('u-alice', 'Nimbus, when does the market open?');
      expect(sink.playing).toBe('It opens at nine on Sunday.');
      talks('u-alice');
      await hears('u-alice', 'no, Saturday', 1_000);
      // The first turn is still writing, so the next one hasn't started.
      expect(turns).toHaveLength(1);
      rest.open();
      await settle();
      expect(turns).toHaveLength(2);
      expect(turns[1]!.saw).toContain('You were part-way through: "It opens at nine on Sunday."');
      expect(played().at(-1)).toBe('Oh, Saturday?');
    });
  });

  // ---------------------------------------------------------------------------

  describe('someone else asks while a reply is playing', () => {
    const midReply = async () => {
      scripts.push(says('It opens at nine on Sunday. ', 'Parking is free there. ', 'Bring a jacket though.'));
      await hears('u-alice', 'Nimbus, when does the market open?');
    };

    it('tells them "one sec" between sentences, finishes, then answers everyone who asked in one turn', async () => {
      await midReply();
      scripts.push(says('Sam, yes. Cara, about ten minutes.'));
      await hears('u-sam', 'Nimbus, is it open on holidays?');
      await hears('u-cara', 'Nimbus, how far is it?', 300);
      await hears('u-sam', 'Nimbus, I mean public holidays', 300);
      expect(turns).toHaveLength(1);
      expect(sink.events).not.toContain('pause');

      await clipEnds();
      // Each is told once, in the order they asked, before the reply goes on.
      expect(played()).toEqual(['It opens at nine on Sunday.', 'Got you, Sam, one sec.']);
      await clipEnds(4);
      expect(played()).toEqual([
        'It opens at nine on Sunday.',
        'Got you, Sam, one sec.',
        'One sec, Cara.',
        'Parking is free there.',
        'Bring a jacket though.',
        'Sam, yes. Cara, about ten minutes.',
      ]);
      expect(turns).toHaveLength(2);
      expect(turns[1]!.askers).toEqual(['Cara: Nimbus, how far is it?', 'Sam: Nimbus, is it open on holidays? Nimbus, I mean public holidays']);
      // Claude knows it said so, and so does the transcript.
      expect(turns[1]!.saw).toContain('Nimbus (you, announcing): Got you, Sam, one sec.');
      expect(await lines()).toContain('*Nimbus: Got you, Sam, one sec.');
    });

    it('says nothing extra when acknowledgements are off, or the reply is nearly over', async () => {
      start({ acknowledge: false });
      await midReply();
      await hears('u-sam', 'Nimbus, is it open on holidays?');
      await clipEnds(3);
      expect(played().slice(0, 3)).toEqual(['It opens at nine on Sunday.', 'Parking is free there.', 'Bring a jacket though.']);

      start();
      session = makeSession(session.transcriptSessionId!);
      scripts.push(says('It opens at nine.'));
      await hears('u-alice', 'Nimbus, when does the market open?');
      await hears('u-sam', 'Nimbus, and on holidays?');
      await clipEnds(2);
      expect(played()).toEqual(['It opens at nine.', 'Okay.']);
    });
  });

  // ---------------------------------------------------------------------------

  describe('after a reply', () => {
    const answered = async () => {
      scripts.push(says('It is seven.'));
      await hears('u-alice', 'Nimbus, what time is it?');
      await clipEnds();
    };

    it('lets anyone carry on without its name for a few seconds, and leaves it to Claude whether to answer', async () => {
      await answered();
      scripts.push(staysQuiet(), says('Half past seven.'));
      await hears('u-sam', 'Alice, are you coming tonight?', 3_000);
      expect(turns[1]!.saw).toContain('Sam (maybe to you): Alice, are you coming tonight?');
      expect(played()).toEqual(['It is seven.']);
      expect(logged).toContain('Stayed quiet: nothing in what Sam said needed a reply.');

      // Staying quiet doesn't reopen the floor: it stays open only for what's left of the eight seconds.
      await hears('u-alice', 'and in half an hour?', 3_000);
      expect(turns[2]!.saw).toContain('Alice (maybe to you): and in half an hour?');
      expect(played()).toEqual(['It is seven.', 'Half past seven.']);
      await clipEnds();

      await hears('u-sam', 'so about tonight', 10_000);
      expect(turns).toHaveLength(3);
    });

    it('counts a follow-up that began just before the reply ended', async () => {
      scripts.push(says('It is seven.'));
      await hears('u-alice', 'Nimbus, what time is it?');
      clock.advance(2_000);
      await clipEnds();
      // They started a second before the reply finished, and stopped a second after.
      clock.advance(1_000);
      const endedAt = clock();
      await service.utterance(session, { userId: 'u-alice', text: 'and in an hour?', startedAt: endedAt - 2_000, lastAudioAt: endedAt - 700, endedAt });
      await settle();
      expect(turns).toHaveLength(2);
    });

    it('can be limited to the people it just answered, or switched off', async () => {
      start({ followUps: 'askers' });
      await answered();
      await hears('u-sam', 'and tomorrow?');
      expect(turns).toHaveLength(1);
      await hears('u-alice', 'and tomorrow?', 500);
      expect(turns).toHaveLength(2);
      await clipEnds();

      start({ followUpMs: 0 });
      session = makeSession(session.transcriptSessionId!);
      turns = [];
      await answered();
      await hears('u-alice', 'and tomorrow?');
      expect(turns).toHaveLength(1);
    });

    it('can put every line to Claude, with or without a reply before it', async () => {
      start({ followUps: 'always' });
      scripts.push(staysQuiet(), says('It is seven.'));
      await hears('u-sam', 'did anyone feed the cat?');
      expect(turns[0]!.saw).toContain('Sam (maybe to you): did anyone feed the cat?');
      await hears('u-alice', 'does anybody know what time it is?', 30_000);
      expect(played()).toEqual(['It is seven.']);
    });

    it('closes the floor at once on "Nimbus, quiet"', async () => {
      await answered();
      await hears('u-sam', 'Nimbus, quiet', 1_000);
      await hears('u-alice', 'and in half an hour?', 1_000);
      // Well inside the eight seconds, but nobody is put to Claude: the name is needed again.
      expect(turns).toHaveLength(1);
      await hears('u-alice', 'Nimbus, and in half an hour?', 1_000);
      expect(turns).toHaveLength(2);
    });

    it("doesn't open the floor after a reply it chose not to give, or one that was cut off", async () => {
      scripts.push(staysQuiet());
      await hears('u-alice', 'Nimbus, never mind actually');
      await hears('u-alice', 'so, anyway');
      expect(turns).toHaveLength(1);

      scripts.push(says('A long story. ', 'With many parts.'));
      await hears('u-alice', 'Nimbus, tell me a story');
      await hears('u-sam', 'Nimbus, stop');
      await hears('u-alice', 'thanks');
      expect(turns).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------

  describe('stop', () => {
    it('handles "Nimbus, stop" itself, cancelling the reply, the turn in flight and everyone waiting', async () => {
      scripts.push(says('A long story. ', 'With many parts. ', 'And an ending.'));
      await hears('u-alice', 'Nimbus, tell me a story');
      const next = gated(says('never said'));
      scripts.push(next.script);
      await hears('u-cara', 'Nimbus, and one for me');
      await hears('u-sam', 'Nimbus, stop it please');

      expect(sink.playing).toBeUndefined();
      expect(turns).toHaveLength(1); // Cara's never started: it was waiting behind the story
      await clipEnds(3);
      expect(played()).toEqual(['A long story.']);
      expect((await lines()).filter((line) => line.startsWith('*'))).toEqual(['*Nimbus: A long story. [cut off]']);
      expect(logged).toContain('Sam told Nimbus to stop.');
      expect(events.at(-1)).toBe('release music');

      // Claude is told what was and wasn't heard.
      await hears('u-alice', 'Nimbus, where were we?');
      expect(turns[1]!.saw).toContain('<bot_note>Sam told you to stop. Of your reply, only this was heard: "A long story."</bot_note>');
      expect(turns[1]!.askers).toEqual(['Alice: Nimbus, where were we?']);
    });

    it('cancels a reply that is still being written, whoever asked for it', async () => {
      const turn = gated(says('never said'));
      scripts.push(turn.script);
      await hears('u-alice', 'Nimbus, tell me a story');
      await hears('u-sam', 'Nimbus, stop');
      expect(turns[0]!.signal!.aborted).toBe(true);
      turn.open();
      await settle();
      expect(played()).toEqual([]);
      expect(events.at(-1)).toBe('release music');
    });

    it('lets the person being answered just say "stop"', async () => {
      scripts.push(says('A long story. ', 'With many parts.'));
      await hears('u-alice', 'Nimbus, tell me a story');
      await hears('u-sam', 'stop'); // not for it: Sam isn't being answered
      expect(sink.playing).toBe('A long story.');
      talks('u-alice');
      await hears('u-alice', 'okay stop');
      expect(sink.playing).toBeUndefined();
      expect(turns).toHaveLength(1);
    });

    it('acts on "Nimbus, stop" before they have finished saying it', async () => {
      musicState = 'playing';
      scripts.push(says('A long story. ', 'With many parts.'));
      await hears('u-alice', 'Nimbus, tell me a story');
      service.partial(session, 'u-sam', 'Nimbus');
      expect(sink.playing).toBe('A long story.');
      service.partial(session, 'u-sam', 'Nimbus stop');
      expect(sink.playing).toBeUndefined();
      // When the whole utterance arrives it isn't acted on a second time (which would pause the music).
      await hears('u-sam', 'Nimbus, stop.');
      expect(events).not.toContain('pause music');
      expect(await lines()).toContain('Sam: Nimbus, stop.');
    });

    it('goes quiet when Claude judges it has been told to', async () => {
      scripts.push(says('A long story. ', 'With many parts.'));
      await hears('u-alice', 'Nimbus, tell me a story');
      talks('u-alice');
      scripts.push(saysItWasToldToStop());
      await hears('u-alice', 'that will do, thank you', 1_000);
      expect(sink.playing).toBeUndefined();
      await clipEnds(2);
      expect(played()).toEqual(['A long story.']);
    });

    it('leaves when told to, once it has said goodbye', async () => {
      scripts.push(saysGoodbyeAndLeaves('Okay, see you later!'));
      await hears('u-alice', 'Nimbus, you can leave now');
      // It is still here while the goodbye plays.
      expect(sink.playing).toBe('Okay, see you later!');
      expect(events).not.toContain('leave g');
      await clipEnds();
      expect(events).toContain('leave g');
      expect(logged).toContain('Leaving the call: Alice said to.');
      expect(await lines()).toEqual(['Alice: Nimbus, you can leave now', '*Nimbus: Okay, see you later!']);
    });

    it('leaves at once when it has nothing to say on the way out', async () => {
      scripts.push(saysGoodbyeAndLeaves());
      await hears('u-alice', 'Nimbus, get out');
      expect(events).toContain('leave g');
    });

    it('still leaves if someone talks over the goodbye and nothing they say changes it', async () => {
      scripts.push(saysGoodbyeAndLeaves('Okay, I will head out now. ', 'Have a good one!'));
      await hears('u-alice', 'Nimbus, leave');
      // Alice talks over it: it freezes, and what she said goes to Claude, which has nothing to add.
      talks('u-alice');
      expect(sink.events).toContain('pause');
      scripts.push(staysQuiet());
      await hears('u-alice', 'thanks', 1_000);
      expect(events).not.toContain('leave g');
      await clipEnds(2);
      expect(played()).toEqual(['Okay, I will head out now.', 'Have a good one!']);
      expect(events).toContain('leave g');
    });

    it('stays if what they say over the goodbye changes its mind, or it is told to stop', async () => {
      scripts.push(saysGoodbyeAndLeaves('Okay, I will head out now. ', 'Have a good one!'));
      await hears('u-alice', 'Nimbus, leave');
      talks('u-alice');
      scripts.push(says('Oh, sure, I can stay.'));
      await hears('u-alice', 'wait, actually stay, one more question', 1_000);
      await clipEnds(3);
      expect(played()).toEqual(['Okay, I will head out now.', 'Oh, sure, I can stay.']);
      expect(events).not.toContain('leave g');

      scripts.push(saysGoodbyeAndLeaves('Okay, I will head out now. ', 'Have a good one!'));
      await hears('u-alice', 'Nimbus, leave', 20_000);
      await hears('u-sam', 'Nimbus, stop', 500);
      await clipEnds(3);
      expect(events).not.toContain('leave g');
    });

    it('pauses the music when there is nothing else to stop', async () => {
      musicState = 'playing';
      await hears('u-alice', 'Nimbus, stop');
      expect(events).toEqual(['pause music']);
      expect(turns).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------

  describe('privacy', () => {
    it('keeps only what a "requests" person says to it, from the transcript and from Claude alike', async () => {
      privacy['u-sam'] = 'requests';
      await hears('u-sam', 'my bank PIN is 1234');
      scripts.push(says('Hello Sam.'));
      await hears('u-sam', 'Nimbus, hello');
      expect(await lines()).toEqual(['Sam: Nimbus, hello']);
      expect(turns[0]!.saw).not.toContain('PIN');
      await clipEnds();

      // Right after being answered, they can carry on without its name like anyone else.
      scripts.push(says('You too.'));
      await hears('u-sam', 'nice to meet you');
      expect(turns).toHaveLength(2);
      await clipEnds();

      // After a reply to someone else, what they say is not for it: dropped again.
      scripts.push(says('Hi Alice.'));
      await hears('u-alice', 'Nimbus, hi', 10_000);
      await clipEnds();
      await hears('u-sam', 'I should check my balance');
      expect(turns).toHaveLength(3);
      expect(JSON.stringify(await lines())).not.toContain('balance');
    });

    it('never treats a "requests" person talking over a reply to someone else as an interruption', async () => {
      start({ bargeIn: 'everyone', followUps: 'always' });
      privacy['u-sam'] = 'requests';
      scripts.push(says('It opens at nine. ', 'Parking is free.'));
      await hears('u-alice', 'Nimbus, when does the market open?');
      await hears('u-sam', 'I owe the bank money');
      expect(turns).toHaveLength(1);
      expect(JSON.stringify(await lines())).not.toContain('bank');
    });

    it('ignores an "off" person completely', async () => {
      privacy['u-sam'] = 'off';
      await hears('u-sam', 'Nimbus, hello');
      expect(turns).toHaveLength(0);
      expect(await lines()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------

  describe('the daily budget', () => {
    it("records but doesn't answer once today's budget is spent", async () => {
      paused = true;
      await hears('u-alice', 'Nimbus, hello');
      expect(turns).toHaveLength(0);
      expect(await lines()).toEqual(['Alice: Nimbus, hello']);
      expect(events).toEqual([]);
    });

    it('stays quiet if the budget runs out between hearing a request and answering it', async () => {
      scripts.push(fails(new BudgetExceededError('g')));
      await hears('u-alice', 'Nimbus, hello');
      expect(played()).toEqual([]);
      expect(events).toEqual(['hold music', 'think', 'release music']);
    });
  });

  // ---------------------------------------------------------------------------

  describe('the call itself', () => {
    it('starts a new conversation when the bot starts listening afresh', async () => {
      scripts.push(says('Hi.'));
      await hears('u-alice', 'Nimbus, hi');
      await clipEnds();
      const next = await transcripts.startSession({ guildId: 'g', channelId: 'vc2', channelName: 'Other', startedAt: clock() });
      session = makeSession(next.id);
      await hears('u-alice', 'Nimbus, hello again', 20_000);
      expect(turns[1]!.saw).toBe('<call_lines>\n[19:00:21] Alice (to you): Nimbus, hello again\n</call_lines>');
    });

    it('drops everything when the call ends', async () => {
      const turn = gated(says('never said'));
      scripts.push(turn.script);
      await hears('u-alice', 'Nimbus, tell me a story');
      service.sessionEnded('g');
      expect(turns[0]!.signal!.aborted).toBe(true);
      turn.open();
      await settle();
      expect(played()).toEqual([]);
      service.sessionEnded('g'); // again: nothing to do
    });
  });
});
