import type { VoiceBasedChannel } from 'discord.js';
import type { VoiceSessionRecord } from '../../src/storage/ports.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/sqlite/database.js';
import { SqliteTranscriptRepository } from '../../src/storage/sqlite/SqliteTranscriptRepository.js';
import { VoiceSessionManager } from '../../src/voice/VoiceSessionManager.js';
import { fakeClock, fakeSchedule, settle, silentLogger } from '../helpers.js';

/** Just enough of a VoiceSession for the manager's occupancy and move handling. */
function fakeSession(channelId: string) {
  let channel = { id: channelId, name: `room-${channelId}` };
  let humans = 1;
  let destroyed = false;
  let listening = true;
  const session = {
    guildId: 'g',
    get channelId() {
      return channel.id;
    },
    get channel() {
      return channel;
    },
    transcriptSessionId: undefined as number | undefined,
    get isDestroyed() {
      return destroyed;
    },
    get listening() {
      return listening;
    },
    humansPresent: () => humans,
    adoptChannel: (next: { id: string; name: string }) => {
      channel = next;
    },
    stopListening: () => {
      listening = false;
    },
    startListening: () => {
      listening = true;
    },
    destroy: () => {
      destroyed = true;
    },
  };
  return { session, setHumans: (count: number) => (humans = count) };
}

describe('VoiceSessionManager', () => {
  let db: SqliteDatabase;
  let transcripts: SqliteTranscriptRepository;
  let clock: ReturnType<typeof fakeClock>;
  let schedule: ReturnType<typeof fakeSchedule>;

  const make = (autoLeaveMs = 120_000) => {
    const manager = new VoiceSessionManager({
      logger: silentLogger(),
      stt: { transcribe: async () => '' },
      tts: { synthesize: async () => { throw new Error('unused'); } },
      clock,
      capture: { silenceMs: 1_000, minSpeechMs: 300, maxUtteranceMs: 10_000 },
      admitSpeaker: () => true,
      meter: { recordClaude: () => undefined, recordTranscription: () => undefined, recordSpeech: () => undefined },
      transcripts,
      resolveChannel: async () => null,
      botUserId: () => 'bot',
      autoLeaveMs,
      schedule,
    });
    const { session, setHumans } = fakeSession('vc');
    (manager as unknown as { sessions: Map<string, unknown> }).sessions.set('g', session);
    return { manager, session, setHumans };
  };
  const left = (userId: string, from = 'vc') => ({ guildId: 'g', userId, oldChannelId: from, newChannelId: null, newChannel: null });
  const joined = (userId: string, to = 'vc') => ({
    guildId: 'g', userId, oldChannelId: null, newChannelId: to, newChannel: { id: to, name: `room-${to}` } as unknown as VoiceBasedChannel,
  });

  beforeEach(() => {
    db = openDatabase(':memory:');
    transcripts = new SqliteTranscriptRepository(db);
    clock = fakeClock();
    schedule = fakeSchedule(clock);
  });
  afterEach(() => db.close());

  it('leaves a couple of minutes after the last person does', () => {
    const { manager, session, setHumans } = make();
    setHumans(0);
    manager.voiceStateChanged(left('alice'));
    expect(schedule.count()).toBe(1);
    schedule.advance(119_000);
    expect(session.isDestroyed).toBe(false);
    schedule.advance(1_000);
    expect(session.isDestroyed).toBe(true);
  });

  it('stays when someone comes back in time, and ignores other channels', () => {
    const { manager, session, setHumans } = make();
    setHumans(0);
    manager.voiceStateChanged(left('alice'));
    schedule.advance(60_000);
    setHumans(1);
    manager.voiceStateChanged(joined('alice'));
    expect(schedule.count()).toBe(0);
    schedule.advance(120_000);
    expect(session.isDestroyed).toBe(false);

    setHumans(0);
    manager.voiceStateChanged(joined('sam', 'elsewhere'));
    expect(schedule.count()).toBe(0);
  });

  it('never leaves on its own when auto-leave is off', () => {
    const { manager, session, setHumans } = make(0);
    setHumans(0);
    manager.voiceStateChanged(left('alice'));
    schedule.advance(24 * 60 * 60_000);
    expect(session.isDestroyed).toBe(false);
  });

  it('follows the bot when someone drags it to another channel, starting a new transcript', async () => {
    const { manager, session } = make();
    const first = await transcripts.startSession({ guildId: 'g', channelId: 'vc', channelName: 'room-vc', startedAt: clock() });
    session.transcriptSessionId = first.id;
    const ended: VoiceSessionRecord[] = [];
    manager.onTranscriptEnded((record) => ended.push(record));

    clock.advance(1_000);
    manager.voiceStateChanged(joined('bot', 'vc2'));
    await settle();
    expect(session.channelId).toBe('vc2');
    expect(ended.map((record) => record.id)).toEqual([first.id]);
    expect(session.transcriptSessionId).not.toBe(first.id);
    const sessions = await transcripts.listSessions('g', { limit: 5 });
    expect(sessions.map((s) => [s.channelId, s.endedAt === null])).toEqual([['vc2', true], ['vc', false]]);
  });
});
