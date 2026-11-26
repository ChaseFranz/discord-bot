import type { Assistant, AssistantReply, AssistantRequest } from '../../src/assistant/Assistant.js';
import type { MusicService } from '../../src/music/MusicService.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/sqlite/database.js';
import { SqliteTranscriptRepository } from '../../src/storage/sqlite/SqliteTranscriptRepository.js';
import { KeywordDetector } from '../../src/voice/keywordDetection.js';
import { VoiceConversationService } from '../../src/voice/VoiceConversationService.js';
import type { VoiceSession } from '../../src/voice/VoiceSession.js';
import { fakeClock, silentLogger } from '../helpers.js';

describe('VoiceConversationService', () => {
  let db: SqliteDatabase;
  let transcripts: SqliteTranscriptRepository;
  let requests: AssistantRequest[];
  let spoken: string[];
  /** Order of what the session and assistant were asked to do. */
  let events: string[];
  let reply: AssistantReply;
  let session: VoiceSession;
  let service: VoiceConversationService;
  const clock = fakeClock();

  const members: Record<string, { displayName: string; user: { bot: boolean } }> = {
    'u-sam': { displayName: 'Sam', user: { bot: false } },
    'u-alice': { displayName: 'Alice', user: { bot: false } },
    'u-bot': { displayName: 'OtherBot', user: { bot: true } },
  };

  beforeEach(async () => {
    db = openDatabase(':memory:');
    transcripts = new SqliteTranscriptRepository(db);
    requests = [];
    spoken = [];
    events = [];
    reply = { text: 'Sure, **pizza** it is!', silent: false, outcome: 'answered', sources: [], model: 'claude-haiku-5-5' };
    const record = await transcripts.startSession({ guildId: 'g', channelId: 'vc', channelName: 'General', startedAt: clock() });
    session = {
      guildId: 'g',
      channelId: 'vc',
      channel: { name: 'General' },
      transcriptSessionId: record.id,
      presentMembers: () => [{ id: 'u-alice', name: 'Alice' }, { id: 'u-sam', name: 'Sam' }],
      resolveMember: async (id: string) => members[id],
      speak: async (text: string) => {
        spoken.push(text);
        events.push(`speak: ${text}`);
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
    const assistant = {
      respond: async (request: AssistantRequest) => {
        requests.push(request);
        events.push('think');
        return reply;
      },
    } as unknown as Assistant;
    service = new VoiceConversationService({
      assistant,
      transcripts,
      music: { describe: () => 'nothing playing' } as unknown as MusicService,
      wakeWord: new KeywordDetector('nimbus'),
      logger: silentLogger(),
      clock,
      assistantName: 'Nimbus',
      botUserId: () => 'u-nimbus',
      ambientContextMinutes: 3,
      wakeSound: Buffer.alloc(16),
    });
  });
  afterEach(() => db.close());

  const say = (userId: string, text: string) => {
    clock.advance(5_000);
    return service.handleUtterance(session, { userId, text, startedAt: clock() - 2_000, endedAt: clock() });
  };

  it('records every utterance but only answers the wake word', async () => {
    await say('u-sam', 'pizza tonight?');
    expect(requests).toHaveLength(0);
    await say('u-alice', 'Nimbus, what do you think?');
    expect(requests).toHaveLength(1);

    const request = requests[0]!;
    expect(request).toMatchObject({ scope: { guildId: 'g', userId: 'u-alice' }, modality: 'voice', userDisplayName: 'Alice', userVoiceChannelId: 'vc' });
    expect(request.ambient!.map((s) => `${s.speakerName}: ${s.text}`)).toEqual(['Sam: pizza tonight?']);

    // The reply is cleaned for speech, spoken, and logged in the transcript as the assistant.
    expect(spoken).toEqual(['Sure, pizza it is!']);
    const { segments } = await transcripts.readRange({ guildId: 'g', limit: 10, order: 'oldest_first' });
    expect(segments.map((s) => `${s.isAssistant ? '*' : ''}${s.speakerName}: ${s.text}`)).toEqual([
      'Sam: pizza tonight?',
      'Alice: Nimbus, what do you think?',
      '*Nimbus: Sure, pizza it is!',
    ]);
  });

  it('holds the music and chimes as soon as it hears its name, until the reply is spoken', async () => {
    await say('u-sam', 'pizza tonight?');
    expect(events).toEqual([]); // ordinary chatter leaves the music alone
    await say('u-alice', 'Nimbus, what do you think?');
    expect(events).toEqual(['hold music', 'chime', 'think', 'speak: Sure, pizza it is!', 'release music']);
  });

  it('holds the music without a chime when the wake sound is off', async () => {
    const quiet = new VoiceConversationService({
      ...(service as unknown as { deps: ConstructorParameters<typeof VoiceConversationService>[0] }).deps,
      wakeSound: undefined,
    });
    clock.advance(1_000);
    await quiet.handleUtterance(session, { userId: 'u-alice', text: 'nimbus hi', startedAt: clock(), endedAt: clock() });
    expect(events).toEqual(['hold music', 'think', 'speak: Sure, pizza it is!', 'release music']);
  });

  it('releases the music even when nothing is said back', async () => {
    reply = { ...reply, text: '', silent: true };
    await say('u-alice', 'Nimbus stop');
    expect(events).toEqual(['hold music', 'chime', 'think', 'release music']);
  });

  it('stays quiet when the assistant asks for silence', async () => {
    reply = { ...reply, text: '', silent: true };
    await say('u-alice', 'Nimbus stop');
    expect(spoken).toEqual([]);
  });

  it('ignores other bots', async () => {
    await say('u-bot', 'Nimbus, beep boop');
    expect(requests).toHaveLength(0);
    expect((await transcripts.readRange({ guildId: 'g', limit: 10, order: 'oldest_first' })).segments).toEqual([]);
  });

  it('apologises out loud if the assistant fails', async () => {
    const failing = new VoiceConversationService({
      ...(service as unknown as { deps: ConstructorParameters<typeof VoiceConversationService>[0] }).deps,
      assistant: { respond: async () => { throw new Error('API down'); } } as unknown as Assistant,
    });
    clock.advance(1_000);
    await failing.handleUtterance(session, { userId: 'u-alice', text: 'nimbus hello', startedAt: clock(), endedAt: clock() });
    expect(spoken).toEqual(['Sorry, something went wrong on my end.']);
    expect(events.at(-1)).toBe('release music');
  });
});
