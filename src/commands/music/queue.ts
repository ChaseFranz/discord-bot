// src/commands/music/queue.ts   ⬅️ adjust the path to your folder layout

import {
  SlashCommandBuilder,
  CommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { queues } from '../../music/musicQueue.js'; // same source as skip.ts

export default {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Displays the current music queue'),

  async execute(interaction: CommandInteraction) {
    if (!interaction.guildId) return;

    const queue = queues.get(interaction.guildId);
    if (!queue) {
      await interaction.editReply('There is no song playing.');
      return;
    }

    /* ---------------- Use the provided interface ---------------- */
    const songs = queue.songs;            // Song[]
    if (songs.length === 0) {
      await interaction.editReply('The queue is currently empty.');
      return;
    }

    /* ---------- Build an embed: now-playing + up-next list -------- */
    const nowPlaying = songs[0];
    const upcoming   = songs.slice(1);    // everything after the first song

    const descriptionParts: string[] = [
      `🎶 **Now playing:** [${nowPlaying.title}](${nowPlaying.url})`,
    ];

    if (upcoming.length) {
      const list = upcoming
        .slice(0, 20)                     // cap to 20 to stay embed-safe
        .map(
          (song, idx) =>
            `**${idx + 1}.** [${song.title}](${song.url})`,
        )
        .join('\n');

      descriptionParts.push('\n__Up next:__\n' + list);
    }

    const embed = new EmbedBuilder()
      .setTitle(`Queue for ${interaction.guild!.name}`)
      .setDescription(descriptionParts.join('\n'))
      .setFooter({
        text:
          upcoming.length > 20
            ? `…and ${upcoming.length - 20} more`
            : `Total tracks: ${songs.length}`,
      });

    await interaction.editReply({ embeds: [embed] });
  },
};
