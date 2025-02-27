import { SlashCommandBuilder, CommandInteraction, CommandInteractionOptionResolver } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } from '@discordjs/voice';
import { queues, Song, MusicQueue } from '../../music/musicQueue.js';
import ytdl from 'ytdl-core';
import ytSearch from 'yt-search';

export class PlayCommand {
  public data = new SlashCommandBuilder()
    .setName('play')
    .setDescription('Plays a song from YouTube using a URL or search query')
    .addStringOption(option =>
      option.setName('query')
        .setDescription('The YouTube URL or search query')
        .setRequired(true)
    );

  private async searchYouTube(query: string): Promise<string | null> { 
    const result = await ytSearch(query); 
    if (result.videos.length > 0) { 
      return result.videos[0].url; // Return the URL of the first result.
    } 
    return null; 
  }

  public async execute(interaction: CommandInteraction): Promise<void> {
    if (!interaction.guildId) return;

    // Check that the member is in a voice channel.
    if (
      !interaction.member ||
      !('voice' in interaction.member) ||
      !(interaction.member as any).voice.channel
    ) {
      await interaction.editReply("You need to be in a voice channel to play music!");
      return;
    }

    const voiceChannel = (interaction.member as any).voice.channel;
    const inputQuery = (interaction.options as CommandInteractionOptionResolver).getString('query', true);

    // If the input is not a valid YouTube URL, treat it as a search query.
    let videoUrl: string | null = inputQuery;
    if (!ytdl.validateURL(inputQuery)) {
      videoUrl = await this.searchYouTube(inputQuery);
      if (!videoUrl) {
        await interaction.editReply("No results found for your search query.");
        return;
      }
    }

    // Retrieve song information.
    const songInfo = await ytdl.getInfo(videoUrl);
    const song: Song = {
      title: songInfo.videoDetails.title,
      url: songInfo.videoDetails.video_url,
    };

    const guildId = interaction.guildId;
    let queue: MusicQueue | undefined = queues.get(guildId);

    if (!queue) {
      // Join the voice channel and create a new queue.
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guildId,
        adapterCreator: interaction.guild!.voiceAdapterCreator,
      });
      const player = createAudioPlayer();
      queue = {
        connection,
        player,
        songs: [],
      };
      queues.set(guildId, queue);

      // Subscribe the connection to the audio player.
      queue.connection.subscribe(player);

      // When the player becomes idle, move to the next song or clear the queue.
      player.on(AudioPlayerStatus.Idle, () => {
        queue!.songs.shift();
        if (queue!.songs.length > 0) {
          PlayCommand.playSong(guildId, queue!.songs[0]);
        } else {
          queue!.connection.destroy();
          queues.delete(guildId);
        }
      });
    }

    // Add the song to the queue.
    queue.songs.push(song);
    if (queue.songs.length === 1) {
      PlayCommand.playSong(guildId, song);
    }

    await interaction.editReply(`Added **${song.title}** to the queue.`);
  }

  private static playSong(guildId: string, song: Song): void {
    const queue = queues.get(guildId);
    if (!queue) return;
    // Create a stream from the YouTube URL.
    const stream = ytdl(song.url, {
      filter: 'audioonly',
      highWaterMark: 1 << 25,
    });
    const resource = createAudioResource(stream);
    queue.player.play(resource);
  }
}

export default new PlayCommand();
