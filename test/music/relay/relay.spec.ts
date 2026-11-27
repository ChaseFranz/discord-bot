import { HelperApi } from '../../../src/music/relay/HelperApi.js';
import { HELPER_POLL_MS, HelperDesk } from '../../../src/music/relay/HelperDesk.js';
import { HelperTrackSource, NOTHING_FOUND } from '../../../src/music/relay/HelperTrackSource.js';
import { MemoryAudioRelayStore, MemoryHelperRegistry, MemoryMusicJobBoard } from '../../../src/music/relay/memory.js';
import { chunkName, type MusicJob } from '../../../src/music/relay/ports.js';
import { formatSetupCode, formatToken, hashSecret, newSecret, parseSetupCode, parseToken, secretMatches } from '../../../src/music/relay/tokens.js';
import { MusicError } from '../../../src/music/types.js';
import { fakeClock, silentLogger } from '../../helpers.js';

const GUILD = '1083158655429509190';
const ALICE = '100000000000000001';
const SAM = '100000000000000002';
const API = 'https://helper.example/';
const GUIDE = 'https://github.com/example/nimbus/tree/main/helper';

describe('helper tokens', () => {
  it('round-trips a token and a setup code', () => {
    const token = { guildId: GUILD, userId: ALICE, secret: newSecret() };
    expect(parseToken(formatToken(token))).toEqual(token);
    const code = formatSetupCode(API, token);
    expect(code).toMatch(/^nimbus1\.[A-Za-z0-9_-]+$/);
    expect(parseSetupCode(`  ${code}\n`)).toEqual({ apiUrl: API, token: formatToken(token) });
  });

  it('refuses anything that is not a token or a setup code', () => {
    for (const text of [undefined, 42, '', 'abc', `${GUILD}.${ALICE}`, `${GUILD}.${ALICE}.short`, `guild.${ALICE}.${newSecret()}`, `${GUILD}.${ALICE}.${newSecret()}.extra`, 'x'.repeat(500)]) {
      expect(parseToken(text)).toBeUndefined();
    }
    for (const code of ['', 'nimbus1.', 'nimbus1.not-base64!', `nimbus2.${Buffer.from('{}').toString('base64url')}`, `nimbus1.${Buffer.from('{"api":"nope","token":"x"}').toString('base64url')}`]) {
      expect(parseSetupCode(code)).toBeUndefined();
    }
  });

  it('checks a secret against its stored hash only', () => {
    const secret = newSecret();
    expect(secretMatches(secret, hashSecret(secret))).toBe(true);
    expect(secretMatches(newSecret(), hashSecret(secret))).toBe(false);
    expect(secretMatches(secret, 'not-a-hash')).toBe(false);
    expect(hashSecret(secret)).not.toContain(secret);
  });
});

describe('music helpers', () => {
  const clock = fakeClock();
  let registry: MemoryHelperRegistry;
  let board: MemoryMusicJobBoard;
  let store: MemoryAudioRelayStore;
  let desk: HelperDesk;
  let api: HelperApi;
  /** Things the "helper" does once the clock reaches a time, run from the track source's waits. */
  let later: Array<{ at: number; run: () => Promise<unknown> | unknown }>;
  let source: HelperTrackSource;

  beforeEach(() => {
    clock.set(Date.UTC(2026, 10, 27, 20, 0, 0));
    registry = new MemoryHelperRegistry();
    board = new MemoryMusicJobBoard();
    store = new MemoryAudioRelayStore('https://bucket.example/');
    desk = new HelperDesk({ guildId: GUILD, registry, clock, apiUrl: API, guideUrl: GUIDE });
    api = new HelperApi({ guildId: GUILD, registry, board, store, clock, logger: silentLogger() });
    later = [];
    source = new HelperTrackSource({
      guildId: GUILD, desk, board, store, clock, checkEveryMs: 250,
      sleep: async (ms) => {
        clock.advance(ms);
        for (const step of later.filter((candidate) => candidate.at <= clock())) {
          later.splice(later.indexOf(step), 1);
          await step.run();
        }
      },
    });
  });

  const post = (path: string, body: Record<string, unknown>) => api.handle({ method: 'POST', path, body: JSON.stringify(body) });
  /** Registers someone and returns the token their helper would send. */
  const setUp = async (userId: string, userName: string) => parseSetupCode(await desk.issue(userId, userName))!.token;
  const inMs = (ms: number, run: () => Promise<unknown> | unknown) => later.push({ at: clock() + ms, run });
  const upload = (job: MusicJob | { id: string }, index: number, text: string) => store.put(`music/${GUILD}/${job.id}/${chunkName(index)}`, Buffer.from(text));
  const read = async (stream: AsyncIterable<Buffer>) => {
    let text = '';
    for await (const chunk of stream) text += chunk.toString();
    return text;
  };

  describe('setting one up', () => {
    it('hands out a personal code and keeps only a hash of its secret', async () => {
      const token = await setUp(ALICE, 'Alice');
      const stored = (await desk.registration(ALICE))!;
      expect(stored).toMatchObject({ guildId: GUILD, userId: ALICE, userName: 'Alice', lastSeenAt: null, version: null });
      expect(JSON.stringify(stored)).not.toContain(parseToken(token)!.secret);
      expect(secretMatches(parseToken(token)!.secret, stored.secretHash)).toBe(true);
    });

    it('replaces an earlier code, and stops working once removed', async () => {
      const first = await setUp(ALICE, 'Alice');
      const second = await setUp(ALICE, 'Alice');
      expect((await post('/poll', { token: first })).status).toBe(401);
      expect((await post('/poll', { token: second })).status).toBe(200);
      expect(await desk.remove(ALICE)).toBe(true);
      expect(await desk.remove(ALICE)).toBe(false);
      expect(await post('/poll', { token: second })).toEqual({
        status: 401,
        body: { error: 'This helper code no longer works. Get a new one with /musichelper.' },
      });
    });

    it('knows who is running a helper right now', async () => {
      const alice = await setUp(ALICE, 'Alice');
      const sam = await setUp(SAM, 'Sam');
      expect(await desk.online()).toEqual([]);
      expect(await desk.blocker()).toBe(
        "Music needs a helper right now, and nobody's is running. YouTube won't send audio to the servers I run on, " +
          `so someone in the server has to run the Nimbus music helper on their own computer. \`/musichelper\` gets you set up in a couple of minutes: ${GUIDE}`,
      );

      await post('/poll', { token: alice, version: '1.0.0' });
      clock.advance(5_000);
      await post('/poll', { token: sam, version: '1.0.0' });
      expect((await desk.online()).map((helper) => helper.userName)).toEqual(['Sam', 'Alice']);
      expect(await desk.blocker()).toBeUndefined();

      // Alice's stops; Sam's keeps asking for work every few seconds.
      for (let seconds = 0; seconds < 30; seconds += 3) {
        clock.advance(3_000);
        await post('/poll', { token: sam, version: '1.0.0' });
      }
      expect((await desk.online()).map((helper) => helper.userName)).toEqual(['Sam']);
    });
  });

  describe('the address helpers talk to', () => {
    it('answers a browser, and refuses anything that is not a proper request', async () => {
      expect(await api.handle({ method: 'GET', path: '/', body: undefined })).toEqual({ status: 200, body: { service: 'nimbus-music-helper', ok: true } });
      expect((await api.handle({ method: 'GET', path: '/poll', body: undefined })).status).toBe(405);
      expect((await api.handle({ method: 'POST', path: '/elsewhere', body: '{}' })).status).toBe(404);
      expect((await api.handle({ method: 'POST', path: '/poll', body: 'not json' })).status).toBe(400);
      expect((await api.handle({ method: 'POST', path: '/poll', body: '[1]' })).status).toBe(400);
      expect((await api.handle({ method: 'POST', path: '/poll', body: JSON.stringify({ token: 'x'.repeat(20_000) }) })).status).toBe(400);
    });

    it('refuses tokens that are malformed, unknown, or for another server', async () => {
      const token = await setUp(ALICE, 'Alice');
      const { secret } = parseToken(token)!;
      for (const bad of [undefined, 'nonsense', formatToken({ guildId: GUILD, userId: SAM, secret }), formatToken({ guildId: '999999999999', userId: ALICE, secret }), formatToken({ guildId: GUILD, userId: ALICE, secret: newSecret() })]) {
        expect((await post('/poll', { token: bad })).status).toBe(401);
      }
    });

    it('writes a check-in down only every ten seconds, however often the helper asks', async () => {
      const token = await setUp(ALICE, 'Alice');
      const first = clock();
      await post('/poll', { token, version: '1.2.3' });
      clock.advance(3_000);
      await post('/poll', { token, version: '1.2.3' });
      expect(await desk.registration(ALICE)).toMatchObject({ lastSeenAt: first, version: '1.2.3' });
      clock.advance(8_000);
      await post('/poll', { token, version: '1.2.4' });
      expect(await desk.registration(ALICE)).toMatchObject({ lastSeenAt: first + 11_000, version: '1.2.4' });
    });

    it('hands a waiting job to the first helper that asks, with where to upload it', async () => {
      const alice = await setUp(ALICE, 'Alice');
      const sam = await setUp(SAM, 'Sam');
      expect(await post('/poll', { token: alice })).toEqual({ status: 200, body: { job: null, pollMs: HELPER_POLL_MS } });

      const job = await board.post(GUILD, 'ytsearch1:jelly fish jam', clock());
      const taken = await post('/poll', { token: alice });
      expect(taken.body).toEqual({
        pollMs: HELPER_POLL_MS,
        job: {
          id: job.id,
          target: 'ytsearch1:jelly fish jam',
          upload: { url: 'https://bucket.example/', fields: { policy: 'memory' }, keyPrefix: `music/${GUILD}/${job.id}/`, maxChunkBytes: 4 * 1024 * 1024 },
        },
      });
      expect(await board.get(GUILD, job.id)).toMatchObject({ status: 'claimed', helper: { userId: ALICE, userName: 'Alice' } });
      // Nobody else gets it.
      expect((await post('/poll', { token: sam })).body.job).toBeNull();
    });

    it("doesn't hand out a job whoever asked has stopped waiting for", async () => {
      const token = await setUp(ALICE, 'Alice');
      await board.post(GUILD, 'ytsearch1:old news', clock());
      clock.advance(31_000);
      expect((await post('/poll', { token })).body.job).toBeNull();
    });

    it("records a helper's reports on its own job, and only well-formed ones", async () => {
      const alice = await setUp(ALICE, 'Alice');
      const sam = await setUp(SAM, 'Sam');
      const job = await board.post(GUILD, 'ytsearch1:jelly fish jam', clock());
      await post('/poll', { token: alice });

      expect((await post('/report', { token: sam, jobId: job.id, kind: 'progress', chunks: 1 })).body).toEqual({ ok: false });
      expect((await post('/report', { token: alice, jobId: job.id, kind: 'found', videoId: 'oWqAf4eex14', title: ' jellyfish\n jam ', durationSeconds: 151.4 })).body).toEqual({ ok: true });
      expect(await board.get(GUILD, job.id)).toMatchObject({ status: 'found', track: { videoId: 'oWqAf4eex14', title: 'jellyfish jam', durationSeconds: 151 } });
      await post('/report', { token: alice, jobId: job.id, kind: 'progress', chunks: 3 });
      await post('/report', { token: alice, jobId: job.id, kind: 'progress', chunks: 2 }); // late arrival: never goes backwards
      expect((await board.get(GUILD, job.id))!.chunks).toBe(3);
      await post('/report', { token: alice, jobId: job.id, kind: 'done', chunks: 5 });
      expect(await board.get(GUILD, job.id)).toMatchObject({ status: 'done', chunks: 5 });
      // Over: nothing more is accepted.
      expect((await post('/report', { token: alice, jobId: job.id, kind: 'progress', chunks: 9 })).body).toEqual({ ok: false });

      for (const bad of [{ kind: 'found', videoId: '../../etc', title: 'x' }, { kind: 'found', videoId: 'oWqAf4eex14' }, { kind: 'progress', chunks: -1 }, { kind: 'done', chunks: 1.5 }, { kind: 'failed' }, { kind: 'dance' }]) {
        expect((await post('/report', { token: alice, jobId: job.id, ...bad })).status).toBe(400);
      }
    });
  });

  describe('asking a helper for a song', () => {
    /** A helper that is running: it has just checked in. */
    const running = async (userId = ALICE, userName = 'Alice') => {
      const token = await setUp(userId, userName);
      await post('/poll', { token });
      return token;
    };
    /** The newest job on the board, as a helper would take it. */
    const take = async (token: string) => ((await post('/poll', { token })).body.job as { id: string; target: string } | null)!;

    it('says how to get one when nobody is running a helper', async () => {
      await expect(source.resolve('jelly fish jam')).rejects.toThrow(MusicError);
      await expect(source.resolve('jelly fish jam')).rejects.toThrow(/nobody's is running.*\/musichelper.*github\.com/);
      expect(await source.resolve('   ')).toBeNull();
    });

    it('posts a search or a plain watch link, and returns what the helper found', async () => {
      const token = await running();
      inMs(500, async () => {
        const job = await take(token);
        expect(job.target).toBe('ytsearch1:jelly fish jam');
        await post('/report', { token, jobId: job.id, kind: 'found', videoId: 'oWqAf4eex14', title: 'jellyfish jam', durationSeconds: 151 });
      });
      const track = await source.resolve('  jelly fish jam ');
      expect(track).toEqual({ title: 'jellyfish jam', url: 'https://www.youtube.com/watch?v=oWqAf4eex14', durationSeconds: 151, handle: expect.any(String) });

      inMs(500, async () => {
        const job = await take(token);
        expect(job.target).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
        await post('/report', { token, jobId: job.id, kind: 'found', videoId: 'dQw4w9WgXcQ', title: 'A video' });
      });
      expect(await source.resolve('https://youtu.be/dQw4w9WgXcQ?si=tracking')).toMatchObject({ title: 'A video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    });

    it('reports nothing found, and passes on why a helper could not get something', async () => {
      const token = await running();
      inMs(500, async () => post('/report', { token, jobId: (await take(token)).id, kind: 'failed', error: NOTHING_FOUND }));
      expect(await source.resolve('asdfghjkl qwertyuiop')).toBeNull();

      inMs(500, async () => post('/report', { token, jobId: (await take(token)).id, kind: 'failed', error: 'Video unavailable' }));
      await expect(source.resolve('oWqAf4eex14')).rejects.toThrow("The music helper couldn't get that: Video unavailable");
    });

    it('gives up on a helper that never picks the job up, or never finds anything', async () => {
      const token = await running();
      await expect(source.resolve('jelly fish jam')).rejects.toThrow('No music helper picked that up.');
      // Nobody will pick it up later either.
      expect((await post('/poll', { token })).body.job).toBeNull();

      await post('/poll', { token });
      inMs(500, () => take(token));
      await expect(source.resolve('jelly fish jam')).rejects.toThrow("Alice's music helper took too long to find that.");
    });

    it('plays the audio as it arrives, in order, to the end', async () => {
      const token = await running();
      let job!: { id: string };
      inMs(500, async () => {
        job = await take(token);
        await post('/report', { token, jobId: job.id, kind: 'found', videoId: 'oWqAf4eex14', title: 'jellyfish jam' });
      });
      const track = (await source.resolve('jelly fish jam'))!;

      // The first part is up before playback starts; the rest follows while it plays.
      upload(job, 0, 'one ');
      await post('/report', { token, jobId: job.id, kind: 'progress', chunks: 1 });
      inMs(1_000, async () => {
        upload(job, 1, 'two ');
        upload(job, 2, 'three');
        await post('/report', { token, jobId: job.id, kind: 'progress', chunks: 3 });
      });
      inMs(2_000, () => post('/report', { token, jobId: job.id, kind: 'done', chunks: 3 }));
      expect(await read(await source.open(track))).toBe('one two three');
    });

    it('fails the song when the helper stops part-way, goes quiet, or a part is missing', async () => {
      const token = await running();
      const begin = async () => {
        let job!: { id: string };
        inMs(500, async () => {
          job = await take(token);
          await post('/report', { token, jobId: job.id, kind: 'found', videoId: 'oWqAf4eex14', title: 'jellyfish jam' });
        });
        const track = (await source.resolve('jelly fish jam'))!;
        return { job, track };
      };

      const failed = await begin();
      upload(failed.job, 0, 'one ');
      await post('/report', { token, jobId: failed.job.id, kind: 'progress', chunks: 1 });
      inMs(1_000, () => post('/report', { token, jobId: failed.job.id, kind: 'failed', error: 'the connection dropped' }));
      await expect(read(await source.open(failed.track))).rejects.toThrow('The music helper stopped part-way: the connection dropped');

      const quiet = await begin();
      await expect(read(await source.open(quiet.track))).rejects.toThrow('The music helper stopped sending the song.');
      expect(await board.get(GUILD, quiet.job.id)).toMatchObject({ status: 'failed' });

      await post('/poll', { token }); // the helper is still running: it keeps checking in
      const gap = await begin();
      await post('/report', { token, jobId: gap.job.id, kind: 'done', chunks: 2 });
      upload(gap.job, 0, 'one ');
      await expect(read(await source.open(gap.track))).rejects.toThrow('Part 1 of the song is missing.');
    });

    it('tells a helper to stop sending a song that has left the queue, and leaves a finished one alone', async () => {
      const token = await running();
      const begin = async () => {
        let job!: { id: string };
        inMs(500, async () => {
          job = await take(token);
          await post('/report', { token, jobId: job.id, kind: 'found', videoId: 'oWqAf4eex14', title: 'a three hour mix' });
        });
        const track = (await source.resolve('a three hour mix'))!;
        return { job, track };
      };

      // Skipped a minute in, while the helper is still uploading it.
      const skipped = await begin();
      upload(skipped.job, 0, 'one ');
      expect((await post('/report', { token, jobId: skipped.job.id, kind: 'progress', chunks: 1 })).body).toEqual({ ok: true });
      await source.discard(skipped.track);
      expect(await board.get(GUILD, skipped.job.id)).toMatchObject({ status: 'failed', error: 'no longer wanted', chunks: 1 });
      // That is how the helper finds out: its next report is turned down, and it stops.
      expect((await post('/report', { token, jobId: skipped.job.id, kind: 'progress', chunks: 2 })).body).toEqual({ ok: false });

      // One that has arrived in full stays as it is.
      const whole = await begin();
      upload(whole.job, 0, 'all of it');
      await post('/report', { token, jobId: whole.job.id, kind: 'done', chunks: 1 });
      await source.discard(whole.track);
      expect(await board.get(GUILD, whole.job.id)).toMatchObject({ status: 'done', error: null });
      // Nothing to do for a track this source has no audio on its way for.
      await source.discard({ title: 'from somewhere else', url: 'https://www.youtube.com/watch?v=oWqAf4eex14' });
    });

    it('asks a helper again for a track it has no audio on its way for', async () => {
      const token = await running();
      inMs(500, async () => {
        const job = await take(token);
        expect(job.target).toBe('https://www.youtube.com/watch?v=oWqAf4eex14');
        await post('/report', { token, jobId: job.id, kind: 'found', videoId: 'oWqAf4eex14', title: 'jellyfish jam' });
        upload(job, 0, 'again');
        await post('/report', { token, jobId: job.id, kind: 'done', chunks: 1 });
      });
      expect(await read(await source.open({ title: 'jellyfish jam', url: 'https://www.youtube.com/watch?v=oWqAf4eex14' }))).toBe('again');
    });
  });
});
