import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import type { BotCommand } from '../types.js';

const QUEUE_DISPLAY_LIMIT = 20;

export const playCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Plays a song from YouTube using a URL or search query')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) => option.setName('query').setDescription('The YouTube URL or search query').setRequired(true)),
  usage: '/play query: https://www.youtube.com/watch?v=example',
  cooldownSeconds: 2,

  async execute(interaction, services) {
    const channel = interaction.member.voice.channel;
    if (!channel) {
      await interaction.editReply('You need to be in a voice channel to play music!');
      return;
    }
    const query = interaction.options.getString('query', true);
    const { track, position } = await services.music.play(interaction.guildId, channel.id, query, interaction.member.displayName);
    await interaction.editReply(
      position === 0 ? `Now playing **${track.title}**.` : `Added **${track.title}** to the queue (position ${position}).`,
    );
  },
};

export const skipCommand: BotCommand = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Skips the current song').setContexts(InteractionContextType.Guild),
  usage: '/skip',
  async execute(interaction, services) {
    const skipped = services.music.skip(interaction.guildId);
    await interaction.editReply(`Skipped **${skipped.title}**.`);
  },
};

export const stopCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stops the music and clears the queue')
    .setContexts(InteractionContextType.Guild),
  usage: '/stop',
  async execute(interaction, services) {
    services.music.stop(interaction.guildId);
    await interaction.editReply('Stopped the music and cleared the queue.');
  },
};

export const pauseCommand: BotCommand = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pauses the current song').setContexts(InteractionContextType.Guild),
  usage: '/pause',
  async execute(interaction, services) {
    services.music.pause(interaction.guildId);
    await interaction.editReply('⏸️  Paused the current song.');
  },
};

export const resumeCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resumes playback if the player is paused')
    .setContexts(InteractionContextType.Guild),
  usage: '/resume',
  async execute(interaction, services) {
    services.music.resume(interaction.guildId);
    await interaction.editReply('▶️  Resumed the song.');
  },
};

export const queueCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Displays the current music queue')
    .setContexts(InteractionContextType.Guild),
  usage: '/queue',
  async execute(interaction, services) {
    const { state, current, upcoming } = services.music.status(interaction.guildId);
    if (!current) {
      await interaction.editReply('There is no song playing.');
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
      .setTitle(`Queue for ${interaction.guild.name}`)
      .setDescription(parts.join('\n').slice(0, 4096))
      .setFooter({
        text:
          upcoming.length > QUEUE_DISPLAY_LIMIT
            ? `…and ${upcoming.length - QUEUE_DISPLAY_LIMIT} more`
            : `Total tracks: ${upcoming.length + 1}`,
      });
    await interaction.editReply({ embeds: [embed] });
  },
};
