import { SlashCommandBuilder, CommandInteraction, GuildMember } from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';
import { IBotCommand } from './types/DiscordModels';

interface ILeaveVoiceChannelCommand extends IBotCommand {
  data: SlashCommandBuilder;
  usage: string;
  execute(interaction: CommandInteraction): Promise<void>;
}

class LeaveVoiceChannelCommand implements ILeaveVoiceChannelCommand {
  data: SlashCommandBuilder;
  usage: string;

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName('leave')
      .setDescription('Leave the voice channel');

    this.usage = '/leave - Makes the bot leave the current voice channel';
  }
  
  async execute(interaction: CommandInteraction): Promise<void> {
    const member = interaction.member as GuildMember;
    const voiceChannel = member.voice.channel;

    if (!voiceChannel) {
      await interaction.editReply({ content: 'You need to be in a voice channel to use this command.' });
      return;
    }

    const connection = getVoiceConnection(voiceChannel.guild.id);
    if (connection) {
      connection.destroy();
      await interaction.editReply({ content: `Left ${voiceChannel.name}` });
    } else {
      await interaction.editReply({ content: 'I am not in a voice channel.' });
    }
  }
}

export default new LeaveVoiceChannelCommand();
