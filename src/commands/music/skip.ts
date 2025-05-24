import { SlashCommandBuilder, CommandInteraction } from 'discord.js';
import { queues } from '../../music/musicQueue.js';

export default {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skips the current song'),
  async execute(interaction: CommandInteraction) {
    if (!interaction.guildId) return;
    const queue = queues.get(interaction.guildId);
    if (!queue) {
      await interaction.editReply("There is no song playing.");
      return;
    }
    // Stop the current song (the idle event will trigger the next song).
    queue.player.stop();
    await interaction.editReply("Skipped the current song.");
  },
};
