import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  let server: Server;
  let home: string;
  let helpers: ChildProcess[];
  let output: string;

  beforeEach(async () => {
    registry = new MemoryHelperRegistry();
    board = new MemoryMusicJobBoard();
    home = mkdtempSync(join(tmpdir(), 'nimbus-helper-test-'));
    helpers = [];
    output = '';

    let api!: HelperApi;
    server = createServer((request, response) => {
      const parts: Buffer[] = [];
      request.on('data', (part: Buffer) => parts.push(part));
      request.on('end', () => {
        void (async () => {
          const body = Buffer.concat(parts);
          if (request.url === '/upload') {
            // What S3 does with a helper's form: store the file under the key it names.
            const form = await new Request('http://local/upload', { method: 'POST', headers: request.headers as Record<string, string>, body }).formData();
            store.put(String(form.get('key')), new Uint8Array(await (form.get('file') as Blob).arrayBuffer()));
            response.writeHead(204).end();
            return;
          }
          const answer = await api.handle({ method: request.method ?? 'GET', path: request.url ?? '/', body: body.toString('utf8') });
          response.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
        })().catch((error: unknown) => response.writeHead(500).end(String(error)));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    store = new MemoryAudioRelayStore(`${address}/upload`);
    desk = new HelperDesk({ guildId: GUILD, registry, clock: Date.now, apiUrl: address, guideUrl: 'https://example.com/helper' });
    api = new HelperApi({ guildId: GUILD, registry, board, store, clock: Date.now, logger: silentLogger(), pollMs: 50 });
    source = new HelperTrackSource({ guildId: GUILD, desk, board, store, clock: Date.now, checkEveryMs: 20 });
  });

  afterEach(async () => {
    for (const helper of helpers) helper.kill();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });

  /** Starts the helper as a person would, optionally with a setup code. */
  const start = (code?: string): ChildProcess => {
    const helper = spawn(process.execPath, [HELPER, ...(code ? [code] : [])], {
      env: { ...process.env, NIMBUS_HELPER_HOME: home, NIMBUS_YT_DLP: FAKE_YT_DLP },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    helper.stdout!.on('data', (text: Buffer) => (output += text.toString()));
    helper.stderr!.on('data', (text: Buffer) => (output += text.toString()));
    helpers.push(helper);
    return helper;
  };
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
    // The code is kept for next time, readable by its owner only.
    const saved = join(home, 'config.json');
    expect(JSON.parse(readFileSync(saved, 'utf8'))).toMatchObject({ token: expect.stringContaining(`${GUILD}.${ALICE}.`) });
    expect(statSync(saved).mode & 0o077).toBe(0);

    const track = (await source.resolve('jelly fish jam'))!;
    expect(track).toMatchObject({ title: 'jellyfish jam', url: 'https://www.youtube.com/watch?v=oWqAf4eex14', durationSeconds: 151 });
    const audio = await readAll(await source.open(track));
    expect(audio.length).toBe(600_000);
    expect(audio.equals(Buffer.from(Array.from({ length: 600_000 }, (_, index) => index % 251)))).toBe(true);
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
    await board.abandon(GUILD, track.handle!, 'skipped', Date.now());
    await until('the helper to stop', () => output.includes('Stopped fetching "jellyfish jam": it\'s no longer wanted.'));
    const sent = (await board.get(GUILD, track.handle!))!.chunks;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await board.get(GUILD, track.handle!))!.chunks).toBe(sent);
  }, PATIENCE_MS);

  it('stops, saying what to do, when its code no longer works', async () => {
    const helper = start(await desk.issue(ALICE, 'Alice'));
    await until('the helper to be seen as running', async () => (await desk.online()).length === 1);
    await desk.remove(ALICE);
    expect(await exitOf(helper)).toBe(1);
    expect(output).toContain('This helper code no longer works. Get a new one with /musichelper.');
  }, PATIENCE_MS);
});
