import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { budgetPausedMessage } from '../textChat.js';
import type { BotCommand } from '../types.js';

export const joinCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join your voice channel and start listening')
    .setContexts(InteractionContextType.Guild),
  usage: '/join - Makes the bot join your current voice channel',

  async execute(interaction, services) {
    const channel = interaction.member.voice.channel;
    if (!channel) {
      await interaction.editReply({ content: 'You need to be in a voice channel to use this command.' });
      return;
    }
    await services.voice.join(channel, { listen: true });
    const { name, wakeWord } = services.config.assistant;
    const retention = services.config.storage.retentionDays;
    const kept = retention > 0 ? `Transcripts are kept for ${retention} day${retention === 1 ? '' : 's'}.` : 'Transcripts are kept until deleted.';
    const paused = services.usage.isPaused(interaction.guildId)
      ? `\n⏸️ ${budgetPausedMessage(services, interaction.guildId)} Until then it won't listen or answer.`
      : '';
    await interaction.editReply({
      content:
        `Joined **${channel.name}**. 🎙️ I'm transcribing this channel so I can follow the conversation. ` +
        `Say "${wakeWord.charAt(0).toUpperCase()}${wakeWord.slice(1)}" to talk to ${name}. ${kept} ` +
        `Rather not be transcribed? Use \`/privacy\`.${paused}`,
    });
  },
};

export const leaveCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the voice channel')
    .setContexts(InteractionContextType.Guild),
  usage: '/leave - Makes the bot leave the current voice channel',

  async execute(interaction, services) {
    const session = services.voice.get(interaction.guildId);
    if (!session) {
      await interaction.editReply({ content: 'I am not in a voice channel.' });
      return;
    }
    const channelName = session.channel.name;
    await services.voice.leave(interaction.guildId);
    await interaction.editReply({ content: `Left ${channelName}` });
  },
};
