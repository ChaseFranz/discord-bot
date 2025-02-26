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
      await interaction.reply("There is no song playing.");
      return;
    }
    // Stop the current song (the idle event will trigger the next song).
    queue.player.stop();
    await interaction.reply("Skipped the current song.");
  },
};
