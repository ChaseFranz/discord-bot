import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { requireVoice, type BotCommand } from '../types.js';

const QUEUE_DISPLAY_LIMIT = 20;

export const playCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Plays a song from YouTube using a URL or search query')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) => option.setName('query').setDescription('The YouTube URL or search query').setRequired(true)),
  usage: '/play query: https://www.youtube.com/watch?v=example',
  cooldownSeconds: 2,
  voice: 'starts-call',

  async execute(context, services) {
    const { music } = requireVoice(services);
    const call = await services.calls.voiceChannelOf(context.guildId, context.userId);
    if (!call) {
      await context.editReply('You need to be in a voice channel to play music!');
      return;
    }
    const query = context.string('query') ?? '';
    const { track, position } = await music.play(context.guildId, call.id, query, context.displayName);
    await context.editReply(
      position === 0 ? `Now playing **${track.title}**.` : `Added **${track.title}** to the queue (position ${position}).`,
    );
  },
};

export const skipCommand: BotCommand = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Skips the current song').setContexts(InteractionContextType.Guild),
  usage: '/skip',
  voice: 'in-call',
  async execute(context, services) {
    const skipped = requireVoice(services).music.skip(context.guildId);
    await context.editReply(`Skipped **${skipped.title}**.`);
  },
};

export const stopCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stops the music and clears the queue')
    .setContexts(InteractionContextType.Guild),
  usage: '/stop',
  voice: 'in-call',
  async execute(context, services) {
    requireVoice(services).music.stop(context.guildId);
    await context.editReply('Stopped the music and cleared the queue.');
  },
};

export const pauseCommand: BotCommand = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pauses the current song').setContexts(InteractionContextType.Guild),
  usage: '/pause',
  voice: 'in-call',
  async execute(context, services) {
    requireVoice(services).music.pause(context.guildId);
    await context.editReply('⏸️  Paused the current song.');
  },
};

export const resumeCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resumes playback if the player is paused')
    .setContexts(InteractionContextType.Guild),
  usage: '/resume',
  voice: 'in-call',
  async execute(context, services) {
    requireVoice(services).music.resume(context.guildId);
    await context.editReply('▶️  Resumed the song.');
  },
};

export const queueCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Displays the current music queue')
    .setContexts(InteractionContextType.Guild),
  usage: '/queue',
  voice: 'in-call',
  async execute(context, services) {
    const { state, current, upcoming } = requireVoice(services).music.status(context.guildId);
    if (!current) {
      await context.editReply('There is no song playing.');
      return;
    }
    const parts = [`🎶 **${state === 'paused' ? 'Paused' : 'Now playing'}:** [${current.title}](${current.url})`];
    if (upcoming.length > 0) {
      const list = upcoming
        .slice(0, QUEUE_DISPLAY_LIMIT)
        .map((track, index) => `**${index + 1}.** [${track.title}](${track.url})`)
        .join('\n');
      parts.push(`\n__Up next:__\n${list}`);
    }
    const embed = new EmbedBuilder()
      .setTitle('Music queue')
      .setDescription(parts.join('\n').slice(0, 4096))
      .setFooter({
        text:
          upcoming.length > QUEUE_DISPLAY_LIMIT
            ? `…and ${upcoming.length - QUEUE_DISPLAY_LIMIT} more`
            : `Total tracks: ${upcoming.length + 1}`,
      });
    await context.editReply({ embeds: [embed] });
  },
};
