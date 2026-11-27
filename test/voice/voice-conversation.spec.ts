import type { AssistantReply, AssistantRequest } from '../../src/assistant/Assistant.js';
import type { MusicStatus } from '../../src/music/types.js';
import type { PrivacyLevel } from '../../src/storage/ports.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/sqlite/database.js';
import { SqliteTranscriptRepository } from '../../src/storage/sqlite/SqliteTranscriptRepository.js';
import { KeywordDetector } from '../../src/voice/keywordDetection.js';
import { VoiceConversationService, type VoiceConversationDeps } from '../../src/voice/VoiceConversationService.js';
import type { VoiceSession } from '../../src/voice/VoiceSession.js';
import { fakeClock, silentLogger } from '../helpers.js';

describe('VoiceConversationService', () => {
  let db: SqliteDatabase;
  let transcripts: SqliteTranscriptRepository;
  let requests: AssistantRequest[];
  /** Order of what the session and assistant were asked to do. */
  let events: string[];
  let respond: (request: AssistantRequest) => Promise<AssistantReply>;
  let privacy: Record<string, PrivacyLevel>;
  let paused: boolean;
  let musicState: MusicStatus['state'];
  let session: VoiceSession;
  let deps: VoiceConversationDeps;
  let service: VoiceConversationService;
  const clock = fakeClock();

  const members: Record<string, { displayName: string; user: { bot: boolean } }> = {
    'u-sam': { displayName: 'Sam', user: { bot: false } },
    'u-alice': { displayName: 'Alice', user: { bot: false } },
    'u-bot': { displayName: 'OtherBot', user: { bot: true } },
  };

  const answer = (text: string, extra: Partial<AssistantReply> = {}): AssistantReply => ({
    text, silent: false, outcome: 'answered', sources: [], model: 'claude-haiku-5-5', ...extra,
  });

  /** A reply streamed in the given pieces. */
  const streamed = (...pieces: string[]) => async (request: AssistantRequest) => {
    for (const piece of pieces) request.onText?.(piece);
    return answer(pieces.join(''));
  };

  beforeEach(async () => {
    db = openDatabase(':memory:');
    transcripts = new SqliteTranscriptRepository(db);
    requests = [];
    events = [];
    privacy = {};
    paused = false;
    musicState = 'idle';
    respond = streamed('Sure, **pizza** it is!');
    const record = await transcripts.startSession({ guildId: 'g', channelId: 'vc', channelName: 'General', startedAt: clock() });
    let replies = 0;
    session = {
      guildId: 'g',
      channelId: 'vc',
      channel: { name: 'General' },
      transcriptSessionId: record.id,
      presentMembers: () => [{ id: 'u-alice', name: 'Alice' }, { id: 'u-sam', name: 'Sam' }],
      resolveMember: async (id: string) => members[id],
      speak: async (text: string) => {
        events.push(`speak: ${text}`);
      },
      openReply: () => {
        const id = ++replies;
        let cancelled = false;
        return {
          say: (text: string) => events.push(`say[${id}]: ${text}`),
          cancel: () => {
            if (!cancelled) events.push(`cancel[${id}]`);
            cancelled = true;
          },
          get cancelled() {
            return cancelled;
          },
          finished: async () => undefined,
        };
      },
      stopSpeaking: () => {
        events.push('stop speaking');
        return false;
      },
      holdMusic: () => {
        events.push('hold music');
        return () => events.push('release music');
      },
      playEarcon: () => {
        events.push('chime');
        return true;
      },
    } as unknown as VoiceSession;
    deps = {
      assistant: {
        respond: async (request: AssistantRequest) => {
          requests.push(request);
          events.push('think');
          return respond(request);
        },
      },
      transcripts,
      music: {
        describe: () => 'nothing playing',
        status: () => ({ state: musicState, current: undefined, upcoming: [] }),
        pause: () => events.push('pause music'),
      },
      sessions: { get: (guildId: string) => (guildId === 'g' ? session : undefined) },
      privacy: { level: async (_guildId: string, userId: string) => privacy[userId] ?? 'full' },
      budget: { isPaused: () => paused },
      wakeWord: new KeywordDetector('nimbus'),
      logger: silentLogger(),
      clock,
      assistantName: 'Nimbus',
      botUserId: () => 'u-nimbus',
      ambientContextMinutes: 3,
      followUpMs: 8_000,
      wakeSound: Buffer.alloc(16),
    };
    service = new VoiceConversationService(deps);
  });
  afterEach(() => db.close());

  /** Someone finishes saying `text`, `gapMs` after the last utterance (started 2 s before it ended). */
  const say = (userId: string, text: string, gapMs = 5_000) => {
    clock.advance(gapMs);
    return service.handleUtterance(session, { userId, text, startedAt: clock() - 2_000, endedAt: clock() });
  };
  const lines = async () =>
    (await transcripts.readRange({ guildId: 'g', limit: 50, order: 'oldest_first' })).segments.map(
      (s) => `${s.isAssistant ? '*' : ''}${s.speakerName}: ${s.text}`,
    );

  it('records every utterance but only answers the wake word', async () => {
    await say('u-sam', 'pizza tonight?');
    expect(requests).toHaveLength(0);
    await say('u-alice', 'Nimbus, what do you think?');
    expect(requests).toHaveLength(1);

    const request = requests[0]!;
    expect(request).toMatchObject({
      scope: { guildId: 'g', userId: 'u-alice' }, modality: 'voice', userDisplayName: 'Alice', userVoiceChannelId: 'vc',
      textChannelId: 'vc', followUp: false,
    });
    expect(request.ambient!.map((s) => `${s.speakerName}: ${s.text}`)).toEqual(['Sam: pizza tonight?']);

    // The reply is cleaned for speech, spoken, and logged in the transcript as the assistant.
    expect(events.filter((e) => e.startsWith('say'))).toEqual(['say[1]: Sure, pizza it is!']);
    expect(await lines()).toEqual(['Sam: pizza tonight?', 'Alice: Nimbus, what do you think?', '*Nimbus: Sure, pizza it is!']);
  });

  it('holds the music and chimes as soon as it hears its name, until the reply is spoken', async () => {
    await say('u-sam', 'pizza tonight?');
    expect(events).toEqual([]); // ordinary chatter leaves the music alone
    await say('u-alice', 'Nimbus, what do you think?');
    expect(events).toEqual(['hold music', 'chime', 'think', 'say[1]: Sure, pizza it is!', 'release music']);
  });

  it('holds the music without a chime when the wake sound is off', async () => {
    service = new VoiceConversationService({ ...deps, wakeSound: undefined });
    await say('u-alice', 'nimbus hi');
    expect(events).toEqual(['hold music', 'think', 'say[1]: Sure, pizza it is!', 'release music']);
  });

  it('speaks each sentence as soon as it has been written', async () => {
    const heardWhileThinking: string[] = [];
    respond = async (request) => {
      request.onText?.('The pizza place opens ');
      request.onText?.('at nine. Want me to ');
      heardWhileThinking.push(...events.filter((e) => e.startsWith('say')));
      request.onText?.('set a reminder?');
      return answer('The pizza place opens at nine. Want me to set a reminder?');
    };
    await say('u-alice', 'Nimbus, when does the pizza place open?');
    // The first sentence went out before the reply was finished.
    expect(heardWhileThinking).toEqual(['say[1]: The pizza place opens at nine.']);
    expect(events.filter((e) => e.startsWith('say'))).toEqual(['say[1]: The pizza place opens at nine.', 'say[1]: Want me to set a reminder?']);
    expect((await lines()).at(-1)).toBe('*Nimbus: The pizza place opens at nine. Want me to set a reminder?');
  });

  describe('follow-up mode', () => {
    it('answers the same person without the wake word for a few seconds after a reply', async () => {
      await say('u-alice', 'Nimbus, what time is it?');
      await say('u-alice', 'and what about tomorrow?', 3_000);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({ text: 'and what about tomorrow?', followUp: true });
      expect(events.filter((e) => e === 'chime')).toHaveLength(2);
    });

    it('needs the wake word again from anyone else, or once the window has passed', async () => {
      await say('u-alice', 'Nimbus, what time is it?');
      await say('u-sam', 'and what about tomorrow?', 3_000);
      expect(requests).toHaveLength(1);
      await say('u-alice', 'thanks anyway', 12_000);
      expect(requests).toHaveLength(1);
    });

    it('is off when followUpMs is 0', async () => {
      service = new VoiceConversationService({ ...deps, followUpMs: 0 });
      await say('u-alice', 'Nimbus, what time is it?');
      await say('u-alice', 'and tomorrow?', 3_000);
      expect(requests).toHaveLength(1);
    });

    it("doesn't open after a reply the assistant chose not to give", async () => {
      respond = async () => answer('', { silent: true });
      await say('u-alice', 'Nimbus, never mind that');
      await say('u-alice', 'so anyway', 3_000);
      expect(requests).toHaveLength(1);
    });
  });

  describe('stop', () => {
    it('handles "Nimbus, stop" itself, without asking Claude', async () => {
      await say('u-alice', 'Nimbus, stop.');
      expect(requests).toHaveLength(0);
      expect(events).toEqual(['stop speaking']);
      // Still part of the transcript.
      expect(await lines()).toEqual(['Alice: Nimbus, stop.']);
    });

    it('cancels a reply that is still being written, whoever asked for it', async () => {
      respond = (request) =>
        new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
      const story = say('u-alice', 'Nimbus, tell me a long story');
      await new Promise((resolve) => setImmediate(resolve));
      await say('u-sam', 'hey Nimbus, shut up please', 1_000);
      await story;
      expect(requests).toHaveLength(1);
      expect(events).toContain('stop speaking');
      expect(events.filter((e) => e.startsWith('say') || e.startsWith('speak'))).toEqual([]);
      expect(events.at(-1)).toBe('release music');
    });

    it('lets the person being answered just say "stop"', async () => {
      let finishReply!: () => void;
      respond = (request) =>
        new Promise((resolve, reject) => {
          finishReply = () => resolve(answer('Here is a long answer.'));
          request.signal!.addEventListener('abort', () => reject(new Error('aborted')));
        });
      const pending = say('u-alice', 'Nimbus, explain quantum physics');
      await new Promise((resolve) => setImmediate(resolve));
      await say('u-sam', 'stop', 500); // someone else: just chatter
      expect(events).not.toContain('stop speaking');
      await say('u-alice', 'stop', 500);
      expect(events).toContain('stop speaking');
      finishReply();
      await pending;
      expect(events.filter((e) => e.startsWith('say'))).toEqual([]);
    });

    it('pauses the music when there is nothing else to stop', async () => {
      musicState = 'playing';
      await say('u-sam', 'Nimbus stop');
      expect(events).toEqual(['stop speaking', 'pause music']);
    });
  });

  describe('privacy', () => {
    it('only keeps what a "requests" person says to the assistant', async () => {
      privacy['u-sam'] = 'requests';
      await say('u-sam', 'my secret plans for the weekend');
      await say('u-sam', 'Nimbus, what is the weather?');
      await say('u-sam', 'and tomorrow?', 3_000); // a follow-up counts as talking to it
      expect(requests.map((r) => r.text)).toEqual(['Nimbus, what is the weather?', 'and tomorrow?']);
      expect((await lines()).filter((line) => line.startsWith('Sam'))).toEqual(['Sam: Nimbus, what is the weather?', 'Sam: and tomorrow?']);
    });

    it('ignores an "off" person completely', async () => {
      privacy['u-sam'] = 'off';
      await say('u-sam', 'Nimbus, can you hear me?');
      expect(requests).toHaveLength(0);
      expect(await lines()).toEqual([]);
    });
  });

  it("records but doesn't answer once today's budget is spent", async () => {
    paused = true;
    await say('u-alice', 'Nimbus, are you there?');
    expect(requests).toHaveLength(0);
    expect(await lines()).toEqual(['Alice: Nimbus, are you there?']);
  });

  it('replaces anything said before a refusal with the refusal', async () => {
    respond = async (request) => {
      request.onText?.('Well, the first step is ');
      request.onText?.('to get the. ');
      return answer("Sorry, I can't help with that one.", { outcome: 'refused' });
    };
    await say('u-alice', 'Nimbus, how do I do something bad?');
    expect(events.filter((e) => e.startsWith('say') || e.startsWith('cancel'))).toEqual([
      'say[1]: Well, the first step is to get the.',
      'cancel[1]',
      "say[2]: Sorry, I can't help with that one.",
    ]);
    expect((await lines()).at(-1)).toBe("*Nimbus: Sorry, I can't help with that one.");
  });

  it('stays quiet and releases the music when the assistant asks for silence', async () => {
    respond = async () => answer('', { silent: true });
    await say('u-alice', 'Nimbus stop talking about that');
    expect(events).toEqual(['hold music', 'chime', 'think', 'cancel[1]', 'release music']);
  });

  it('ignores other bots', async () => {
    await say('u-bot', 'Nimbus, beep boop');
    expect(requests).toHaveLength(0);
    expect(await lines()).toEqual([]);
  });

  it('apologises out loud if the assistant fails', async () => {
    respond = async () => {
      throw new Error('API down');
    };
    await say('u-alice', 'nimbus hello');
    expect(events.filter((e) => e.startsWith('speak'))).toEqual(['speak: Sorry, something went wrong on my end.']);
    expect(events.at(-1)).toBe('release music');
  });

  it('announces things in the call, and says when it cannot', async () => {
    expect(await service.announce('g', "Alice, here's your reminder: **stretch**.")).toBe(true);
    expect(events).toEqual(['hold music', 'chime', "speak: Alice, here's your reminder: stretch.", 'release music']);
    expect(await lines()).toEqual(["*Nimbus: Alice, here's your reminder: stretch."]);
    expect(await service.announce('elsewhere', 'hello')).toBe(false);
  });
});
