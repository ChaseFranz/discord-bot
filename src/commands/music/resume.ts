// src/commands/music/resume.ts   ← adjust the path if needed

import {
  SlashCommandBuilder,
  CommandInteraction,
} from 'discord.js';
import { AudioPlayerStatus } from '@discordjs/voice';
import { queues } from '../../music/musicQueue.js';   // same import path as pause.ts

export default {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resumes playback if the player is paused'),

  async execute(interaction: CommandInteraction) {
    if (!interaction.guildId) return;

    const queue = queues.get(interaction.guildId);
    if (!queue) {
      await interaction.editReply('There is no song playing.');
      return;
    }

    /* -------- Only unpause if we’re actually paused -------- */
    const status = queue.player.state.status;
    if (status !== AudioPlayerStatus.Paused) {
      await interaction.editReply('The player is not paused.');
      return;
    }

    /* -------------------------- Resume --------------------- */
    const success = queue.player.unpause();   // returns false if it fails
    if (!success) {
      await interaction.editReply('⚠️  Failed to resume—please try again.');
      return;
    }

    await interaction.editReply('▶️  Resumed the song.');
  },
};
