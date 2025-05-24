// src/commands/music/pause.ts   ← adjust the path if needed

import {
  SlashCommandBuilder,
  CommandInteraction,
} from 'discord.js';
import { AudioPlayerStatus } from '@discordjs/voice';
import { queues } from '../../music/musicQueue.js';   // same import path as skip.ts

export default {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pauses the current song'),

  async execute(interaction: CommandInteraction) {
    if (!interaction.guildId) return;

    const queue = queues.get(interaction.guildId);
    if (!queue) {
      await interaction.editReply('There is no song playing.');
      return;
    }

    /* ------ Only pause if we’re actually playing or buffering ------ */
    const status = queue.player.state.status;
    if (
      status !== AudioPlayerStatus.Playing &&
      status !== AudioPlayerStatus.Buffering
    ) {
      await interaction.editReply('The player is already paused.');
      return;
    }

    /* ------------------------- Pause it --------------------------- */
    const success = queue.player.pause(true);   // true = “pause, don’t unpause”
    if (!success) {
      await interaction.editReply('⚠️  Failed to pause—please try again.');
      return;
    }

    await interaction.editReply('⏸️  Paused the current song.');
  },
};
