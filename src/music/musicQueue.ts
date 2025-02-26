import { VoiceConnection, createAudioPlayer } from '@discordjs/voice';

export interface Song {
  title: string;
  url: string;
}

export interface MusicQueue {
  connection: VoiceConnection;
  player: ReturnType<typeof createAudioPlayer>;
  songs: Song[];
}

export const queues = new Map<string, MusicQueue>();