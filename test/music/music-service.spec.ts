import { Readable } from 'node:stream';
import { MusicService } from '../../src/music/MusicService.js';
import { MusicError, type MusicHost, type MusicOutput, type PlaybackState, type Track, type TrackSource } from '../../src/music/types.js';
import { silentLogger } from '../helpers.js';

class FakeOutput implements MusicOutput {
  state: PlaybackState = 'idle';
  readonly played: string[] = [];
  private idleListeners: Array<() => void> = [];

  play(stream: Readable) {
    this.played.push(String(stream.read()));
    this.state = 'playing';
  }
  stop() {
    const was = this.state;
    this.state = 'idle';
    if (was !== 'idle') this.idleListeners.forEach((l) => l());
  }
  pause() {
    if (this.state !== 'playing') return false;
    this.state = 'paused';
    return true;
  }
  resume() {
    if (this.state !== 'paused') return false;
    this.state = 'playing';
    return true;
  }
  onIdle(listener: () => void) {
    this.idleListeners.push(listener);
    return () => {
      this.idleListeners = this.idleListeners.filter((l) => l !== listener);
    };
  }
  onError() {
    return () => undefined;
  }
  /** Simulates the current track ending naturally. */
  finish() {
    this.stop();
  }
}

const source: TrackSource = {
  resolve: async (query) => (query === 'nothing' ? null : { title: `Song ${query}`, url: `https://yt/${query}` }),
  open: async (track: Track) => {
    if (track.title.includes('broken')) throw new Error('403');
    return Readable.from([track.title]);
  },
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('MusicService', () => {
  let output: FakeOutput;
  let finished: string[];
  let music: MusicService;

  beforeEach(() => {
    output = new FakeOutput();
    finished = [];
    const host: MusicHost = { ensureOutput: async () => output, queueFinished: (guildId) => finished.push(guildId) };
    music = new MusicService(host, source, silentLogger());
  });

  it('plays the first track and queues the rest', async () => {
    expect((await music.play('g', 'vc', 'a')).position).toBe(0);
    expect((await music.play('g', 'vc', 'b')).position).toBe(1);
    expect(output.played).toEqual(['Song a']);
    expect(music.status('g')).toMatchObject({ state: 'playing', current: { title: 'Song a' }, upcoming: [{ title: 'Song b' }] });
    expect(music.describe('g')).toBe('playing "Song a" (1 more queued)');
  });

  it('advances when a track ends and reports when the queue is done', async () => {
    await music.play('g', 'vc', 'a');
    await music.play('g', 'vc', 'b');
    output.finish();
    await flush();
    expect(output.played).toEqual(['Song a', 'Song b']);
    output.finish();
    await flush();
    expect(finished).toEqual(['g']);
    expect(music.status('g').current).toBeUndefined();
  });

  it('skips over tracks that fail to open', async () => {
    await music.play('g', 'vc', 'a');
    await music.play('g', 'vc', 'broken');
    await music.play('g', 'vc', 'c');
    music.skip('g');
    await flush();
    expect(output.played).toEqual(['Song a', 'Song c']);
  });

  it('pauses and resumes with clear errors for the wrong state', async () => {
    expect(() => music.pause('g')).toThrow(MusicError);
    await music.play('g', 'vc', 'a');
    music.pause('g');
    expect(() => music.pause('g')).toThrow('already paused');
    music.resume('g');
    expect(() => music.resume('g')).toThrow('not paused');
  });

  it('stop clears everything and lets the host decide whether to leave', async () => {
    await music.play('g', 'vc', 'a');
    await music.play('g', 'vc', 'b');
    expect(music.stop('g')).toBe(2);
    expect(finished).toEqual(['g']);
    expect(music.status('g')).toEqual({ state: 'idle', current: undefined, upcoming: [] });
  });

  it('rejects searches with no result', async () => {
    await expect(music.play('g', 'vc', 'nothing')).rejects.toThrow('No results');
  });

  describe('with a source that prepares tracks ahead of playing them', () => {
    let discarded: string[];
    let joinFails: boolean;

    beforeEach(() => {
      discarded = [];
      joinFails = false;
      const host: MusicHost = {
        ensureOutput: async () => {
          if (joinFails) throw new MusicError('Join a voice channel first.');
          return output;
        },
        queueFinished: (guildId) => finished.push(guildId),
      };
      const preparing: TrackSource = {
        ...source,
        discard: async (track) => {
          discarded.push(track.title);
          if (track.title.includes('stubborn')) throw new Error('the database is down');
        },
      };
      music = new MusicService(host, preparing, silentLogger());
    });

    it('tells it when a track finishes, is skipped, or cannot be opened', async () => {
      await music.play('g', 'vc', 'a');
      await music.play('g', 'vc', 'b');
      await music.play('g', 'vc', 'broken');
      await music.play('g', 'vc', 'c');
      expect(discarded).toEqual([]);
      output.finish();
      await flush();
      expect(discarded).toEqual(['Song a']);
      music.skip('g');
      await flush();
      // "b" was skipped, and "broken" could not be opened on the way to "c".
      expect(discarded).toEqual(['Song a', 'Song b', 'Song broken']);
      expect(music.status('g').current).toMatchObject({ title: 'Song c' });
    });

    it('tells it about everything still queued when the music is stopped or the call goes away', async () => {
      await music.play('g', 'vc', 'a');
      await music.play('g', 'vc', 'b');
      music.stop('g');
      await flush();
      expect(discarded).toEqual(['Song a', 'Song b']);

      await music.play('g', 'vc', 'c');
      await music.play('g', 'vc', 'd');
      music.detach('g');
      await flush();
      expect(discarded).toEqual(['Song a', 'Song b', 'Song c', 'Song d']);
    });

    it('tells it about a track that never got into a queue, and carries on if telling it fails', async () => {
      joinFails = true;
      await expect(music.play('g', 'vc', 'a')).rejects.toThrow('Join a voice channel first.');
      await flush();
      expect(discarded).toEqual(['Song a']);

      joinFails = false;
      await music.play('g', 'vc', 'stubborn');
      await music.play('g', 'vc', 'b');
      music.skip('g');
      await flush();
      expect(discarded).toEqual(['Song a', 'Song stubborn']);
      expect(music.status('g').current).toMatchObject({ title: 'Song b' });
    });
  });
});
