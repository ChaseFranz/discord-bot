import { SlashCommandBuilder, CommandInteraction } from 'discord.js';
import { queues } from '../../music/musicQueue.js';

export default {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stops the music and clears the queue'),
  async execute(interaction: CommandInteraction) {
    if (!interaction.guildId) return;
    const queue = queues.get(interaction.guildId);
    if (!queue) {
      await interaction.editReply("There is no song playing.");
      return;
    }
    // Clear the queue, stop playback, and disconnect.
    queue.songs = [];
    queue.player.stop();
    queue.connection.destroy();
    queues.delete(interaction.guildId);
    await interaction.editReply("Stopped the music and cleared the queue.");
  },
};
