import { SlashCommandBuilder, type EmbedBuilder } from 'discord.js';
import { CommandDispatcher } from '../../src/discord/CommandDispatcher.js';
import { helpCommand } from '../../src/discord/commands/help.js';
import * as musicCommands from '../../src/discord/commands/music.js';
import type { CommandContext, Reply } from '../../src/discord/context.js';
import type { AppServices, BotCommand } from '../../src/discord/types.js';
import { MUSIC_TURNED_OFF } from '../../src/music/types.js';
import { silentLogger } from '../helpers.js';

function context(replies: Reply[]): CommandContext {
  return {
    commandName: 'play', guildId: 'g', userId: 'u', userTag: 'alice', displayName: 'Alice', channelId: 'c', channelName: 'general',
    string: () => 'jelly fish jam',
    editReply: async (reply) => void replies.push(reply),
    followUp: async (reply) => void replies.push(reply),
  };
}

const services = (musicEnabled: boolean, commands: readonly BotCommand[] = []) =>
  ({
    logger: silentLogger(),
    config: { music: { enabled: musicEnabled }, assistant: { name: 'Nimbus' } },
    mentionChat: false,
    commands: () => commands,
  }) as unknown as AppServices;

describe('music turned off (MUSIC_ENABLED=false)', () => {
  const allMusic = Object.values(musicCommands) as BotCommand[];

  it('covers every music command', () => {
    expect(allMusic.map((command) => command.data.name).sort()).toEqual(['pause', 'play', 'queue', 'resume', 'skip', 'stop']);
    expect(allMusic.every((command) => command.feature === 'music')).toBe(true);
  });

  it('answers a music command with "turned off" instead of running it', async () => {
    let ran = false;
    const play: BotCommand = {
      data: new SlashCommandBuilder().setName('play').setDescription('Plays'),
      usage: '/play',
      feature: 'music',
      execute: async () => {
        ran = true;
      },
    };
    const replies: Reply[] = [];
    const off = new CommandDispatcher([play], [], services(false));
    expect(off.unavailable(play)).toBe(MUSIC_TURNED_OFF);
    await off.runCommand(play, context(replies));
    expect(ran).toBe(false);
    expect(replies).toEqual([MUSIC_TURNED_OFF]);

    const on = new CommandDispatcher([play], [], services(true));
    expect(on.unavailable(play)).toBeUndefined();
    await on.runCommand(play, context(replies));
    expect(ran).toBe(true);
  });

  it('leaves other commands alone', async () => {
    const replies: Reply[] = [];
    const usage: BotCommand = {
      data: new SlashCommandBuilder().setName('usage').setDescription('Usage'),
      usage: '/usage',
      execute: async (ctx) => ctx.editReply('spent $0.12 today'),
    };
    await new CommandDispatcher([usage], [], services(false)).runCommand(usage, context(replies));
    expect(replies).toEqual(['spent $0.12 today']);
  });

  it('marks the music commands as turned off in /help', async () => {
    const replies: Reply[] = [];
    await helpCommand.execute(context(replies), services(false, [helpCommand, ...allMusic]));
    const [embed] = (replies[0] as { embeds: EmbedBuilder[] }).embeds;
    const names = (embed!.data.fields ?? []).map((field) => field.name);
    expect(names).toEqual(['/help', ...allMusic.map((command) => `/${command.data.name} (turned off)`)]);

    replies.length = 0;
    await helpCommand.execute(context(replies), services(true, [helpCommand, ...allMusic]));
    const [onEmbed] = (replies[0] as { embeds: EmbedBuilder[] }).embeds;
    expect((onEmbed!.data.fields ?? []).every((field) => !field.name.includes('turned off'))).toBe(true);
  });
});
