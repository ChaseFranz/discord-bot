import { ApplicationCommandType, InteractionType, type APIChatInputApplicationCommandGuildInteraction } from 'discord-api-types/v10';
import { SlashCommandBuilder } from 'discord.js';
import {
  HEARTBEAT_STALE_MS,
  MemoryVoiceTaskQueue,
  MemoryVoiceTaskStore,
  START_TIMEOUT_MS,
  VoiceTaskAnnouncer,
  VoiceTaskControl,
  VoiceTaskRunner,
  isLive,
  type CallSnapshot,
} from '../../src/calls/voiceTask.js';
import type { CallInfo, CommandContext, Reply } from '../../src/discord/context.js';
import type { BotCommand } from '../../src/discord/types.js';
import { fakeClock, silentLogger } from '../helpers.js';

const interaction = (name: string, id = `i-${name}`) =>
  ({
    type: InteractionType.ApplicationCommand,
    id,
    application_id: 'app',
    token: 'tok',
    guild_id: 'g',
    member: { user: { id: 'u1', username: 'alice' } },
    data: { id: 'cmd', name, type: ApplicationCommandType.ChatInput },
  }) as unknown as APIChatInputApplicationCommandGuildInteraction;

const command = (name: string, voice: BotCommand['voice']): BotCommand => ({
  data: new SlashCommandBuilder().setName(name).setDescription(name),
  usage: `/${name}`,
  voice,
  execute: async () => undefined,
});

function context(replies: Reply[]): CommandContext {
  return {
    commandName: 'join', guildId: 'g', userId: 'u1', userTag: 'alice', displayName: 'Alice', channelId: 'c', channelName: 'general',
    string: () => null,
    editReply: async (reply) => void replies.push(reply),
    followUp: async (reply) => void replies.push(reply),
  };
}

describe('voice task control (Lambda side)', () => {
  let store: MemoryVoiceTaskStore;
  let queue: MemoryVoiceTaskQueue;
  let started: number;
  let failStart: boolean;
  let inVoice: boolean;
  const clock = fakeClock();
  let control: VoiceTaskControl;

  beforeEach(() => {
    store = new MemoryVoiceTaskStore();
    queue = new MemoryVoiceTaskQueue();
    started = 0;
    failStart = false;
    inVoice = true;
    const calls: CallInfo = {
      voiceChannelOf: async () => (inVoice ? { id: 'vc', name: 'General', people: [] } : undefined),
      musicStatus: async () => 'nothing playing',
    };
    control = new VoiceTaskControl({
      store,
      queue,
      launcher: {
        start: async () => {
          if (failStart) throw new Error('no capacity');
          started++;
          return `arn:task/${started}`;
        },
      },
      calls,
      clock,
      logger: silentLogger(),
    });
  });

  it('starts the voice task for /join and hands it the command', async () => {
    const replies: Reply[] = [];
    await control.dispatch(command('join', 'starts-call'), interaction('join'), context(replies));
    expect(started).toBe(1);
    expect(replies).toEqual(['On my way to **General**… give me about half a minute.']);
    expect(queue.pending.map((m) => m.message.kind)).toEqual(['interaction']);
    expect((await store.get('g'))).toMatchObject({ status: 'starting', taskArn: 'arn:task/1' });
  });

  it("doesn't start a second task while one is starting or running", async () => {
    await control.dispatch(command('join', 'starts-call'), interaction('join', 'a'), context([]));
    await control.dispatch(command('play', 'starts-call'), interaction('play', 'b'), context([]));
    expect(started).toBe(1);
    expect(queue.pending).toHaveLength(2);
    // While it runs, every voice command just goes to it (it replies itself).
    await store.heartbeat('g', clock(), undefined);
    const replies: Reply[] = [];
    await control.dispatch(command('skip', 'in-call'), interaction('skip'), context(replies));
    expect(replies).toEqual([]);
    expect(queue.pending).toHaveLength(3);
  });

  it('starts a new task once the old one has gone quiet', async () => {
    await store.heartbeat('g', clock(), undefined);
    clock.advance(HEARTBEAT_STALE_MS + 1);
    await control.dispatch(command('join', 'starts-call'), interaction('join'), context([]));
    expect(started).toBe(1);
  });

  it('answers in-call commands itself when no task is running, and checks the caller is in voice', async () => {
    const replies: Reply[] = [];
    await control.dispatch(command('skip', 'in-call'), interaction('skip'), context(replies));
    inVoice = false;
    await control.dispatch(command('join', 'starts-call'), interaction('join'), context(replies));
    expect(replies).toEqual(["I'm not in a voice channel right now.", 'You need to be in a voice channel first.']);
    expect(started).toBe(0);
    expect(queue.pending).toHaveLength(0);
  });

  it('owns up when the task fails to start, and lets the next try start one', async () => {
    failStart = true;
    const replies: Reply[] = [];
    await control.dispatch(command('join', 'starts-call'), interaction('join'), context(replies));
    expect(replies).toEqual(["I couldn't get started for the call. Please try again in a minute."]);
    expect(await store.get('g')).toBeUndefined();
    expect(queue.pending).toHaveLength(0);
  });

  it('passes announcements to a running task in a call, and reports who is in it', async () => {
    const announcer = new VoiceTaskAnnouncer({ store, queue, clock });
    expect(await announcer.announce('g', 'hi')).toBe(false);
    const call: CallSnapshot = { channelId: 'vc', channelName: 'General', people: [{ id: 'u1', name: 'Alice' }], music: 'nothing playing' };
    await store.heartbeat('g', clock(), call);
    expect(await announcer.callMembers('g')).toEqual([{ id: 'u1', name: 'Alice' }]);
    expect(await announcer.currentCall('g')).toEqual(call);
    expect(await announcer.announce('g', 'Reminder: stretch.')).toBe(true);
    expect(queue.pending.at(-1)?.message).toMatchObject({ kind: 'announce', text: 'Reminder: stretch.' });
  });

  it('knows when a record is live', () => {
    const now = 1_000_000;
    expect(isLive(undefined, now)).toBe(false);
    expect(isLive({ guildId: 'g', status: 'starting', startedAt: now - START_TIMEOUT_MS + 1, heartbeatAt: 0 }, now)).toBe(true);
    expect(isLive({ guildId: 'g', status: 'starting', startedAt: now - START_TIMEOUT_MS, heartbeatAt: 0 }, now)).toBe(false);
    expect(isLive({ guildId: 'g', status: 'running', startedAt: 0, heartbeatAt: now - HEARTBEAT_STALE_MS + 1 }, now)).toBe(true);
  });
});

describe('voice task runner (the task itself)', () => {
  it('runs orders, reports in, and finishes once out of a call', async () => {
    const store = new MemoryVoiceTaskStore();
    const queue = new MemoryVoiceTaskQueue();
    const clock = fakeClock();
    const ran: string[] = [];
    let call: CallSnapshot | undefined;
    const runner = new VoiceTaskRunner({
      guildId: 'g',
      store,
      queue,
      runInteraction: async (order) => {
        ran.push(order.data.name);
        if (order.data.name === 'join') call = { channelId: 'vc', channelName: 'General', people: [], music: 'nothing playing' };
        if (order.data.name === 'leave') call = undefined;
      },
      announce: async (_guildId, text) => {
        ran.push(`say ${text}`);
        return true;
      },
      currentCall: () => call,
      idleExitMs: 60_000,
      clock,
      logger: silentLogger(),
    });

    await queue.send({ kind: 'interaction', interaction: interaction('join'), sentAt: clock() });
    await queue.send({ kind: 'announce', guildId: 'g', text: 'Reminder!', sentAt: clock() });
    await queue.send({ kind: 'interaction', interaction: interaction('leave'), sentAt: clock() });
    const done = runner.run();
    await new Promise((resolve) => setImmediate(resolve));
    expect(ran).toEqual(['join', 'say Reminder!', 'leave']);
    expect((await store.get('g'))?.status).toBe('running');

    clock.advance(61_000);
    runner.stop(); // wake the long poll; it notices it's been idle long enough
    await done;
    expect(await store.get('g')).toBeUndefined();
  });

  it('skips orders too old to answer', async () => {
    const store = new MemoryVoiceTaskStore();
    const queue = new MemoryVoiceTaskQueue();
    const clock = fakeClock();
    const ran: string[] = [];
    const runner = new VoiceTaskRunner({
      guildId: 'g', store, queue, clock, logger: silentLogger(), idleExitMs: 0,
      runInteraction: async (order) => void ran.push(order.data.name),
      announce: async () => true,
      currentCall: () => undefined,
    });
    await queue.send({ kind: 'interaction', interaction: interaction('join'), sentAt: clock() - 20 * 60_000 });
    await runner.run();
    expect(ran).toEqual([]);
  });
});
