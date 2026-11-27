import { SlashCommandBuilder } from 'discord.js';
import { CommandDispatcher } from '../../src/discord/CommandDispatcher.js';
import type { CommandContext, ComponentContext, Reply } from '../../src/discord/context.js';
import type { AppServices, BotCommand, ComponentHandler } from '../../src/discord/types.js';
import { MusicError } from '../../src/music/types.js';
import { silentLogger } from '../helpers.js';

function commandContext(replies: Reply[]): CommandContext {
  return {
    commandName: 'test',
    guildId: 'g',
    userId: 'u',
    userTag: 'alice',
    displayName: 'Alice',
    channelId: 'c',
    channelName: 'general',
    string: () => null,
    editReply: async (reply) => {
      replies.push(reply);
    },
    followUp: async (reply) => {
      replies.push(reply);
    },
  };
}

const command = (execute: BotCommand['execute'], cooldownSeconds?: number): BotCommand => ({
  data: new SlashCommandBuilder().setName('test').setDescription('A test command'),
  usage: '/test',
  cooldownSeconds,
  execute,
});

describe('CommandDispatcher', () => {
  const services = { logger: silentLogger() } as unknown as AppServices;

  it('runs commands and turns failures into a reply', async () => {
    const replies: Reply[] = [];
    const ok = command(async (context) => context.editReply('done'));
    const musicProblem = command(async () => {
      throw new MusicError('Nothing is playing right now.');
    });
    const crash = command(async () => {
      throw new Error('boom');
    });
    const dispatcher = new CommandDispatcher([ok], [], services);
    await dispatcher.runCommand(ok, commandContext(replies));
    await dispatcher.runCommand(musicProblem, commandContext(replies));
    await dispatcher.runCommand(crash, commandContext(replies));
    expect(replies).toEqual([
      'done',
      { content: 'Nothing is playing right now.', embeds: [], components: [] },
      { content: 'There was an error executing that command.', embeds: [], components: [] },
    ]);
    expect(dispatcher.command('test')).toBe(ok);
    expect(dispatcher.command('nope')).toBeUndefined();
  });

  it('applies per-user cooldowns', () => {
    const slow = command(async () => undefined, 10);
    const dispatcher = new CommandDispatcher([slow], [], services);
    expect(dispatcher.checkCooldown(slow, 'u', 1_000)).toBeUndefined();
    expect(dispatcher.checkCooldown(slow, 'u', 4_000)).toBeCloseTo(7);
    expect(dispatcher.checkCooldown(slow, 'other', 4_000)).toBeUndefined();
    expect(dispatcher.checkCooldown(slow, 'u', 11_000)).toBeUndefined();
  });

  it('routes components by prefix and tells the clicker when one fails', async () => {
    const seen: string[] = [];
    const handlers: ComponentHandler[] = [
      { prefix: 'memories', execute: async (context) => void seen.push(`memories ${context.values.join(',')}`) },
      { prefix: 'reset', execute: async () => { throw new Error('nope'); } },
    ];
    const dispatcher = new CommandDispatcher([], handlers, services);
    const component = (customId: string, values: string[] = []): ComponentContext => ({
      guildId: 'g', userId: 'u', userTag: 'alice', customId, kind: values.length ? 'select' : 'button', values,
      update: async () => undefined,
      notify: async (message) => void seen.push(`notify ${message}`),
    });
    await dispatcher.runComponent(component('memories:forget', ['12']));
    await dispatcher.runComponent(component('reset:confirm'));
    await dispatcher.runComponent(component('unknown:thing'));
    expect(seen).toEqual(['memories 12', 'notify Something went wrong.']);
  });
});

describe('command metadata for the HTTPS edge', () => {
  it('lists exactly the ephemeral commands', async () => {
    const { allCommands } = await import('../../src/runtime/core.js');
    const { EPHEMERAL_COMMANDS } = await import('../../src/discord/commandMeta.js');
    const ephemeral = allCommands().commands.filter((command) => command.ephemeral).map((command) => command.data.name);
    expect([...EPHEMERAL_COMMANDS].sort()).toEqual(ephemeral.sort());
  });
});
