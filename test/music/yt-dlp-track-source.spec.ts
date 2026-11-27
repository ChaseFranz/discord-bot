import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { YtDlpTrackSource, youTubeVideoId } from '../../src/music/YtDlpTrackSource.js';

const FAKE = join(process.cwd(), 'test/music/fake-yt-dlp.mjs');
const TRACK = { title: 'jellyfish jam', url: 'https://www.youtube.com/watch?v=oWqAf4eex14' };

describe('youTubeVideoId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=oWqAf4eex14', 'oWqAf4eex14'],
    ['https://youtube.com/watch?v=oWqAf4eex14&t=30s&list=PL123', 'oWqAf4eex14'],
    ['https://m.youtube.com/watch?v=oWqAf4eex14', 'oWqAf4eex14'],
    ['https://music.youtube.com/watch?v=oWqAf4eex14', 'oWqAf4eex14'],
    ['https://youtu.be/oWqAf4eex14?si=abc', 'oWqAf4eex14'],
    ['https://www.youtube.com/shorts/oWqAf4eex14', 'oWqAf4eex14'],
    ['https://www.youtube.com/embed/oWqAf4eex14', 'oWqAf4eex14'],
    ['https://www.youtube-nocookie.com/embed/oWqAf4eex14', 'oWqAf4eex14'],
    ['oWqAf4eex14', 'oWqAf4eex14'],
  ])('finds the ID in %s', (input, id) => {
    expect(youTubeVideoId(input)).toBe(id);
  });

  it.each([
    'jelly fish jam',
    // Eleven lowercase letters: a one-word search, not an ID.
    'beethovenss',
    'https://example.com/watch?v=oWqAf4eex14',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/playlist?list=PL1234567890',
    'ftp://youtube.com/watch?v=oWqAf4eex14',
    'https://youtube.com.evil.example/watch?v=oWqAf4eex14',
  ])('finds no ID in %s', (input) => {
    expect(youTubeVideoId(input)).toBeUndefined();
  });
});

describe('YtDlpTrackSource', () => {
  let dir: string;
  let log: string;
  const source = (mode: string, timeoutMs?: number) =>
    new YtDlpTrackSource({ executable: process.execPath, prefixArgs: [FAKE, mode, log], nodePath: '/opt/node', ...(timeoutMs ? { timeoutMs } : {}) });
  const call = (): { pid: number; args: string[] } => JSON.parse(readFileSync(log, 'utf8')) as { pid: number; args: string[] };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const exited = async (pid: number) => {
    for (let waited = 0; alive(pid) && waited < 5_000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
    return !alive(pid);
  };
  const readAll = async (stream: Readable) => {
    let bytes = 0;
    for await (const chunk of stream) bytes += (chunk as Buffer).length;
    return bytes;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yt-dlp-test-'));
    log = join(dir, 'call.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('searches YouTube only, with Node as the JavaScript runtime', async () => {
    const track = await source('found').resolve('  jelly fish jam ');
    expect(track).toEqual({ title: 'jellyfish jam', url: 'https://www.youtube.com/watch?v=oWqAf4eex14', durationSeconds: 152 });
    const { args } = call();
    expect(args).toEqual(expect.arrayContaining(['--ignore-config', '--no-playlist', '--flat-playlist']));
    expect(args.slice(args.indexOf('--use-extractors'), args.indexOf('--use-extractors') + 2)).toEqual(['--use-extractors', 'youtube,youtube:search']);
    expect(args.slice(args.indexOf('--js-runtimes'), args.indexOf('--js-runtimes') + 2)).toEqual(['--js-runtimes', 'node:/opt/node']);
    // The query comes after "--", so it can never be read as an option.
    expect(args.slice(-2)).toEqual(['--', 'ytsearch1:jelly fish jam']);
  });

  it('looks up a YouTube link directly, as its plain watch URL', async () => {
    await source('found').resolve('https://youtu.be/oWqAf4eex14?si=tracking');
    const { args } = call();
    expect(args).toContain('--skip-download');
    expect(args).not.toContain('--flat-playlist');
    expect(args.slice(-2)).toEqual(['--', 'https://www.youtube.com/watch?v=oWqAf4eex14']);
  });

  it('treats a link to another site as words to search for', async () => {
    await source('found').resolve('https://example.com/song.mp3');
    expect(call().args.at(-1)).toBe('ytsearch1:https://example.com/song.mp3');
  });

  it('returns null when nothing matches, or for an empty query', async () => {
    expect(await source('nothing').resolve('asdfghjkl qwerty')).toBeNull();
    expect(await source('nothing').resolve('   ')).toBeNull();
  });

  it("reports yt-dlp's own error message", async () => {
    await expect(source('unavailable').resolve('oWqAf4eex14')).rejects.toThrow(
      'yt-dlp exited with code 1: [youtube] oWqAf4eex14: Video unavailable',
    );
  });

  it('says so when yt-dlp is not installed', async () => {
    const missing = new YtDlpTrackSource({ executable: join(dir, 'no-such-yt-dlp') });
    await expect(missing.resolve('jelly fish jam')).rejects.toThrow(/yt-dlp isn't installed .*YT_DLP_PATH/);
    await expect(missing.open(TRACK)).rejects.toThrow(/yt-dlp isn't installed/);
  });

  it('reports its version', async () => {
    expect(await source('version').version()).toBe('2026.11.23');
  });

  it('streams the best audio of the video, all of it', async () => {
    const stream = await source('audio').open(TRACK);
    const { args } = call();
    expect(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2)).toEqual(['-f', 'bestaudio/best']);
    expect(args.slice(-4)).toEqual(['-o', '-', '--', 'https://www.youtube.com/watch?v=oWqAf4eex14']);
    expect(await readAll(stream)).toBe(128 * 1024);
  });

  it('fails to open, rather than playing silence, when yt-dlp gives no audio', async () => {
    await expect(source('unavailable').open(TRACK)).rejects.toThrow('Video unavailable');
  });

  it('errors the stream when yt-dlp fails part-way through', async () => {
    const stream = await source('audio-then-fail').open(TRACK);
    await expect(readAll(stream)).rejects.toThrow('connection reset');
  });

  it('stops yt-dlp when the stream is destroyed (skip or stop)', async () => {
    const stream = await source('endless').open(TRACK);
    const { pid } = call();
    expect(alive(pid)).toBe(true);
    stream.destroy();
    expect(await exited(pid)).toBe(true);
  });

  it('gives up, and stops yt-dlp, when no audio arrives in time', async () => {
    await expect(source('hang', 300).open(TRACK)).rejects.toThrow('yt-dlp sent no audio within 1 second');
    expect(await exited(call().pid)).toBe(true);
  });

  it('refuses to open anything but a YouTube video', async () => {
    await expect(source('audio').open({ title: 'x', url: 'https://example.com/song.mp3' })).rejects.toThrow('Not a YouTube video');
  });
});
