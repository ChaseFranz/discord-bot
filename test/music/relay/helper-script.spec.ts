import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { HelperApi } from '../../../src/music/relay/HelperApi.js';
import { HelperDesk } from '../../../src/music/relay/HelperDesk.js';
import { HelperTrackSource } from '../../../src/music/relay/HelperTrackSource.js';
import { MemoryAudioRelayStore, MemoryHelperRegistry, MemoryMusicJobBoard } from '../../../src/music/relay/memory.js';
import { silentLogger } from '../../helpers.js';

/**
 * The real helper script, run as its own process the way a person runs it, against the real
 * helper API and track source over real HTTP. Only yt-dlp is a stand-in (fake-yt-dlp-helper.mjs).
 */
const HELPER = join(process.cwd(), 'helper/nimbus-music-helper.mjs');
const FAKE_YT_DLP = join(process.cwd(), 'test/music/relay/fake-yt-dlp-helper.mjs');
const GUILD = '1083158655429509190';
const ALICE = '100000000000000001';

/** These start real processes and wait on real time. */
const PATIENCE_MS = 30_000;

describe('the music helper script', () => {
  let registry: MemoryHelperRegistry;
  let board: MemoryMusicJobBoard;
  let store: MemoryAudioRelayStore;
  let desk: HelperDesk;
  let source: HelperTrackSource;
  let api: HelperApi;
  let server: Server;
  let address: string;
  let home: string;
  /** Where altered copies of the helper script are kept (see altered). */
  let scripts: string;
  let helpers: ChildProcess[];
  let output: string;
  /** What the server hands out as the ffmpeg download; a 404 while unset. */
  let ffmpegDownload: Buffer | undefined;

  /** Sets the service up, with upload forms that last `expiresInSeconds`. */
  const service = (expiresInSeconds?: number) => {
    store = new MemoryAudioRelayStore(`${address}/upload`, expiresInSeconds);
    desk = new HelperDesk({ guildId: GUILD, registry, clock: Date.now, apiUrl: address, guideUrl: 'https://example.com/helper', downloadUrl: 'https://example.com/files' });
    api = new HelperApi({ guildId: GUILD, registry, board, store, clock: Date.now, logger: silentLogger(), pollMs: 50 });
    source = new HelperTrackSource({ guildId: GUILD, desk, board, store, clock: Date.now, checkEveryMs: 20 });
  };

  beforeEach(async () => {
    registry = new MemoryHelperRegistry();
    board = new MemoryMusicJobBoard();
    home = mkdtempSync(join(tmpdir(), 'nimbus-helper-test-'));
    scripts = mkdtempSync(join(tmpdir(), 'nimbus-helper-scripts-'));
    helpers = [];
    output = '';
    ffmpegDownload = undefined;

    server = createServer((request, response) => {
      const parts: Buffer[] = [];
      request.on('data', (part: Buffer) => parts.push(part));
      request.on('end', () => {
        void (async () => {
          const body = Buffer.concat(parts);
          if (request.url === '/upload' && request.headers['content-type']?.startsWith('multipart/')) {
            // What S3 does with a helper's form: store the file under the key it names.
            const form = await new Request('http://local/upload', { method: 'POST', headers: request.headers as Record<string, string>, body }).formData();
            store.put(String(form.get('key')), new Uint8Array(await (form.get('file') as Blob).arrayBuffer()));
            response.writeHead(204).end();
            return;
          }
          if (request.url?.startsWith('/ffmpeg/')) {
            if (ffmpegDownload) response.writeHead(200).end(ffmpegDownload);
            else response.writeHead(404).end();
            return;
          }
          const answer = await api.handle({ method: request.method ?? 'GET', path: request.url ?? '/', body: body.toString('utf8') });
          response.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
        })().catch((error: unknown) => response.writeHead(500).end(String(error)));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    service();
  });

  afterEach(async () => {
    for (const helper of helpers) helper.kill();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
    rmSync(scripts, { recursive: true, force: true });
  });

  /**
   * Starts the helper as a person would, optionally with a setup code. Unless a test says
   * otherwise it is told there is an ffmpeg, so that it doesn't go and download one.
   */
  const start = (code?: string, options: { script?: string; env?: Record<string, string | undefined> } = {}): ChildProcess => {
    const helper = spawn(process.execPath, [options.script ?? HELPER, ...(code ? [code] : [])], {
      env: { ...process.env, NIMBUS_HELPER_HOME: home, NIMBUS_YT_DLP: FAKE_YT_DLP, NIMBUS_FFMPEG: '/somewhere/ffmpeg', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    helper.stdout!.on('data', (text: Buffer) => (output += text.toString()));
    helper.stderr!.on('data', (text: Buffer) => (output += text.toString()));
    helpers.push(helper);
    return helper;
  };
  /**
   * A copy of the helper script with some of its fixed values changed, for what can't be waited
   * for or reached in a test: `changes` are [from, to] pairs, each of which must match once.
   */
  const altered = (...changes: Array<[string | RegExp, string]>): string => {
    let script = readFileSync(HELPER, 'utf8');
    for (const [from, to] of changes) {
      const matches = typeof from === 'string' ? script.split(from).length - 1 : (script.match(new RegExp(from, 'g')) ?? []).length;
      if (matches !== 1) throw new Error(`Expected one match for ${String(from)} in the helper script, found ${matches}.`);
      script = script.replace(from, to);
    }
    const file = join(scripts, `helper-${changes.length}-${Date.now()}.mjs`);
    writeFileSync(file, script);
    return file;
  };
  /** The song the stand-in for yt-dlp sends: its bytes follow a pattern, so any gap or repeat shows. */
  const pattern = (length: number) => Buffer.from(Array.from({ length }, (_, index) => index % 251));
  const until = async (what: string, condition: () => boolean | Promise<boolean>) => {
    for (let waited = 0; waited < 15_000; waited += 25) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${what}. The helper printed:\n${output}`);
  };
  /** The helper's exit code, once it has ended and everything it printed has arrived. */
  const exitOf = (helper: ChildProcess) => new Promise<number | null>((resolve) => helper.once('close', resolve));
  const connected = async () => {
    start(await desk.issue(ALICE, 'Alice'));
    await until('the helper to be seen as running', async () => (await desk.online()).length === 1);
  };
  const readAll = async (stream: AsyncIterable<Buffer>) => {
    const parts: Buffer[] = [];
    for await (const part of stream) parts.push(part);
    return Buffer.concat(parts);
  };

  it('saves its code, is seen as running, and relays a song byte for byte', async () => {
    await connected();
    await until('the helper to say it is connected', () => output.includes('Connected to Nimbus.'));
    // Started as a file, it says how to start it again as a file (the installers' own wording is tested with them).
    expect(output).toContain('From now on, "node nimbus-music-helper.mjs" is enough.');
    // The code is kept for next time, readable by its owner only.
    const saved = join(home, 'config.json');
    expect(JSON.parse(readFileSync(saved, 'utf8'))).toMatchObject({ token: expect.stringContaining(`${GUILD}.${ALICE}.`) });
    expect(statSync(saved).mode & 0o077).toBe(0);

    const track = (await source.resolve('jelly fish jam'))!;
    expect(track).toMatchObject({ title: 'jellyfish jam', url: 'https://www.youtube.com/watch?v=oWqAf4eex14', durationSeconds: 151 });
    const audio = await readAll(await source.open(track));
    expect(audio.length).toBe(600_000);
    expect(audio.equals(pattern(600_000))).toBe(true);
    // In three uploads: two full chunks and the rest.
    expect(await board.get(GUILD, track.handle!)).toMatchObject({ status: 'done', chunks: 3, helper: { userId: ALICE, userName: 'Alice' } });
    await until('the helper to say it sent the song', () => output.includes('Sent "jellyfish jam" (0.6 MB).'));
    expect(output).toContain('Fetching "jellyfish jam"');
  }, PATIENCE_MS);

  it('starts again from the saved code, and fetches several songs at once', async () => {
    const code = await desk.issue(ALICE, 'Alice');
    const first = start(code);
    await until('the code to be saved', () => existsSync(join(home, 'config.json')));
    first.kill();
    await exitOf(first);

    start();
    await until('the helper to be seen as running', async () => (await desk.online()).length === 1);
    const tracks = await Promise.all([source.resolve('song one'), source.resolve('song two')]);
    const sizes = await Promise.all(tracks.map(async (track) => (await readAll(await source.open(track!))).length));
    expect(sizes).toEqual([600_000, 600_000]);
  }, PATIENCE_MS);

  it('says when nothing was found, and why a video could not be fetched', async () => {
    await connected();
    expect(await source.resolve('nothing like this exists')).toBeNull();
    await expect(source.resolve('an unavailable video')).rejects.toThrow(
      "The music helper couldn't get that: [youtube] aaaaaaaaaaa: This video is unavailable",
    );
    await until('the helper to mention both', () => output.includes('Nothing found for') && output.includes('Could not fetch that'));
  }, PATIENCE_MS);

  it('stops fetching a song that is no longer wanted', async () => {
    await connected();
    const track = (await source.resolve('an endless song'))!;
    await until('some of it to arrive', async () => ((await board.get(GUILD, track.handle!))?.chunks ?? 0) >= 2);
    // Skipped: the track leaves the queue, which is what tells its helper.
    await source.discard(track);
    await until('the helper to stop', () => output.includes('Stopped fetching "jellyfish jam": it\'s no longer wanted.'));
    const sent = (await board.get(GUILD, track.handle!))!.chunks;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await board.get(GUILD, track.handle!))!.chunks).toBe(sent);
  }, PATIENCE_MS);

  describe('live streams and long videos', () => {
    const FLUSHING_FAST: [string, string] = ['const FLUSH_MS = 2_000;', 'const FLUSH_MS = 150;'];

    it('relays a live stream in pieces by time as it arrives, and stops when it is let go of', async () => {
      start(await desk.issue(ALICE, 'Alice'), { script: altered(FLUSHING_FAST) });
      await until('the helper to be seen as running', async () => (await desk.online()).length === 1);

      const track = (await source.resolve('a live stream'))!;
      // The date and time yt-dlp adds to a live stream's title are left off.
      expect(track).toMatchObject({ title: 'lofi hip hop radio', url: 'https://www.youtube.com/watch?v=rFZHOHl-L8A' });
      expect(track.durationSeconds).toBeUndefined();
      expect((await board.get(GUILD, track.handle!))!.track).toMatchObject({ live: true });

      const pieces: Buffer[] = [];
      for await (const piece of await source.open(track)) {
        pieces.push(piece);
        if (pieces.length === 6) break;
      }
      // The burst it starts with fills a whole piece; after that it comes in as fast as it plays,
      // and goes up in whatever has arrived rather than waiting for a piece to fill.
      expect(pieces[0]!.length).toBe(256 * 1024);
      expect(pieces.slice(1).every((piece) => piece.length < 256 * 1024)).toBe(true);
      const audio = Buffer.concat(pieces);
      expect(audio.equals(pattern(audio.length))).toBe(true);
      expect((await board.get(GUILD, track.handle!))!.listenedAt).not.toBeNull();

      await source.discard(track);
      await until('the helper to stop', () => output.includes('Stopped fetching "lofi hip hop radio": it\'s no longer wanted.'));
      expect(output).toContain('Fetching "lofi hip hop radio" (a live stream: it is sent for as long as someone is listening)');
    }, PATIENCE_MS);

    it('asks for a new upload form before the one it has runs out', async () => {
      // Forms that last a second: the helper asks for the next one half-way through.
      service(1);
      await connected();
      const track = (await source.resolve('an endless song'))!;
      await until('it to have asked for more forms', () => store.issued >= 3);
      expect((await board.get(GUILD, track.handle!))!.status).toBe('found');
      await source.discard(track);
      await until('the helper to stop', () => output.includes('Stopped fetching "jellyfish jam": it\'s no longer wanted.'));
    }, PATIENCE_MS);

    it('tells yt-dlp where its ffmpeg is', async () => {
      const argsFile = join(scripts, 'args.json');
      start(await desk.issue(ALICE, 'Alice'), { env: { FAKE_YT_DLP_ARGS_FILE: argsFile } });
      await until('the helper to be seen as running', async () => (await desk.online()).length === 1);
      await readAll(await source.open((await source.resolve('jelly fish jam'))!));
      const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
      expect(args[args.indexOf('--ffmpeg-location') + 1]).toBe('/somewhere/ffmpeg');
      expect(args.slice(-2)).toEqual(['--', 'ytsearch1:jelly fish jam']);
    }, PATIENCE_MS);
  });

  describe('getting ffmpeg', () => {
    /** Nothing but Node on the PATH, so no ffmpeg is found there; and no ffmpeg named in the environment. */
    const NO_FFMPEG = { NIMBUS_FFMPEG: undefined, PATH: dirname(process.execPath) };
    const build = `${process.platform}-${process.arch}`;
    const whenThereIsABuild = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64'].includes(build) ? it : it.skip;
    /** The helper, downloading ffmpeg from this test's server and expecting `download` to be what arrives. */
    const downloadingFrom = (download: Buffer) =>
      altered(
        ["const FFMPEG_RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';", `const FFMPEG_RELEASE = '${address}/ffmpeg';`],
        [new RegExp(`('${build}': \\{ file: '[^']+', sha256: ')[0-9a-f]{64}'`), `$1${createHash('sha256').update(download).digest('hex')}'`],
      );
    const pretendFfmpeg = gzipSync(Buffer.from('#!/bin/sh\necho "ffmpeg version 6.1.1 (a stand-in)"\n'));

    whenThereIsABuild('downloads it once, checks it, and uses it for live streams', async () => {
      ffmpegDownload = pretendFfmpeg;
      const argsFile = join(scripts, 'args.json');
      const script = downloadingFrom(pretendFfmpeg);
      const first = start(await desk.issue(ALICE, 'Alice'), { script, env: { ...NO_FFMPEG, FAKE_YT_DLP_ARGS_FILE: argsFile } });
      await until('the helper to be seen as running', async () => (await desk.online()).length === 1);
      expect(output).toContain('Downloading ffmpeg (about 30 MB, this once)');
      expect(output).toContain('ffmpeg is ready.');
      const ffmpeg = join(home, 'ffmpeg');
      expect(statSync(ffmpeg).mode & 0o111).not.toBe(0);

      const track = (await source.resolve('a live stream'))!;
      await until('the stream to start', async () => ((await board.get(GUILD, track.handle!))?.chunks ?? 0) >= 1);
      const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
      expect(args[args.indexOf('--ffmpeg-location') + 1]).toBe(ffmpeg);
      await source.discard(track);
      first.kill();
      await exitOf(first);

      // The next time it starts, it has it already (and the server would no longer hand it out).
      ffmpegDownload = undefined;
      output = '';
      start(undefined, { script, env: NO_FFMPEG });
      await until('the helper to connect again', () => output.includes('Connected to Nimbus.'));
      expect(output).not.toContain('Downloading ffmpeg');
    }, PATIENCE_MS);

    whenThereIsABuild('refuses a download that is not the build it expects, and carries on without', async () => {
      ffmpegDownload = gzipSync(Buffer.from('#!/bin/sh\necho "something else"\n'));
      start(await desk.issue(ALICE, 'Alice'), { script: downloadingFrom(pretendFfmpeg), env: NO_FFMPEG });
      await until('the helper to be seen as running', async () => (await desk.online()).length === 1);
      expect(output).toContain('Could not get ffmpeg: the download did not match its known checksum.');
      expect(existsSync(join(home, 'ffmpeg'))).toBe(false);
    }, PATIENCE_MS);

    whenThereIsABuild('still fetches ordinary songs without it, and says why a live stream cannot be', async () => {
      // The download fails (a 404), as it would with no connection to GitHub.
      start(await desk.issue(ALICE, 'Alice'), { script: downloadingFrom(pretendFfmpeg), env: NO_FFMPEG });
      await until('the helper to be seen as running', async () => (await desk.online()).length === 1);
      expect(output).toMatch(/Could not get ffmpeg: .*answered 404\. Live streams won't play until there is one; every other song is fine\./);

      expect((await readAll(await source.open((await source.resolve('jelly fish jam'))!))).length).toBe(600_000);
      await expect(source.resolve('a live stream')).rejects.toThrow(
        "That's a live stream, and Alice's music helper has no ffmpeg, which fetching one takes. How to add it: https://example.com/helper",
      );
      await until('the helper to say so too', () => output.includes("it's a live stream, and there is no ffmpeg here to fetch it with"));
      // That is not something a newer yt-dlp would fix.
      expect(output).not.toContain('Checking for a newer yt-dlp');
    }, PATIENCE_MS);
  });

  it('stops, saying what to do, when its code no longer works', async () => {
    const helper = start(await desk.issue(ALICE, 'Alice'));
    await until('the helper to be seen as running', async () => (await desk.online()).length === 1);
    await desk.remove(ALICE);
    expect(await exitOf(helper)).toBe(1);
    expect(output).toContain('This helper code no longer works. Get a new one with /musichelper.');
  }, PATIENCE_MS);
});
