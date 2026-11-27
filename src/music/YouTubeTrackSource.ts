import type { Readable } from 'node:stream';
import { parseVideoId, Quality, SearchType, Ytdl } from '@distube/ytdl-core';
import type { Track, TrackSource } from './types.js';

/** Resolves and streams YouTube audio with @distube/ytdl-core. */
export class YouTubeTrackSource implements TrackSource {
  constructor(private readonly ytdl: Ytdl = new Ytdl()) {}

  async resolve(query: string): Promise<Track | null> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return null;

    if (parseVideoId(trimmed)) {
      const info = await this.ytdl.getInfo(trimmed);
      return {
        title: info.videoDetails.title,
        url: info.videoDetails.url,
        durationSeconds: info.videoDetails.lengthSeconds || undefined,
      };
    }

    const [first] = await this.ytdl.search(trimmed, { limit: 1, type: SearchType.Video });
    if (!first) return null;
    return { title: first.title, url: first.url, durationSeconds: first.lengthSeconds };
  }

  async open(track: Track): Promise<Readable> {
    return this.ytdl.download(track.url, {
      quality: Quality.HighestAudio,
      filter: { hasAudio: true, hasVideo: false },
    });
  }
}
