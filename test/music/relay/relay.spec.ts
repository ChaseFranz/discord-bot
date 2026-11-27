import { HelperApi } from '../../../src/music/relay/HelperApi.js';
import { HELPER_POLL_MS, HelperDesk, LISTENING_EVERY_MS, UNHEARD_MS } from '../../../src/music/relay/HelperDesk.js';
import { HelperTrackSource, LIVE_NEEDS_FFMPEG, NOTHING_FOUND } from '../../../src/music/relay/HelperTrackSource.js';
import { MemoryAudioRelayStore, MemoryHelperRegistry, MemoryMusicJobBoard } from '../../../src/music/relay/memory.js';
import { chunkName, type MusicJob } from '../../../src/music/relay/ports.js';
import { formatSetupCode, formatToken, hashSecret, newSecret, parseSetupCode, parseToken, secretMatches } from '../../../src/music/relay/tokens.js';
import { MusicError } from '../../../src/music/types.js';
import { fakeClock, settle, silentLogger } from '../../helpers.js';

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
  /** What the track source does again and again (saying it is listening to a live stream), run the same way. */
  let repeating: Array<{ everyMs: number; next: number; run: () => void; stopped: boolean }>;
  let source: HelperTrackSource;

  beforeEach(() => {
    clock.set(Date.UTC(2026, 10, 27, 20, 0, 0));
    registry = new MemoryHelperRegistry();
    board = new MemoryMusicJobBoard();
    store = new MemoryAudioRelayStore('https://bucket.example/');
    desk = new HelperDesk({ guildId: GUILD, registry, clock, apiUrl: API, guideUrl: GUIDE });
    api = new HelperApi({ guildId: GUILD, registry, board, store, clock, logger: silentLogger() });
    later = [];
    repeating = [];
    source = new HelperTrackSource({
      guildId: GUILD, desk, board, store, clock, checkEveryMs: 250,
      sleep: async (ms) => {
        clock.advance(ms);
        for (const timer of repeating) {
          for (; !timer.stopped && timer.next <= clock(); timer.next += timer.everyMs) timer.run();
        }
        for (const step of later.filter((candidate) => candidate.at <= clock())) {
          later.splice(later.indexOf(step), 1);
          await step.run();
        }
      },
      every: (everyMs, run) => {
        const timer = { everyMs, next: clock() + everyMs, run, stopped: false };
        repeating.push(timer);
        return () => {
          timer.stopped = true;
        };
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
          upload: {
            url: 'https://bucket.example/', fields: { policy: 'memory' }, keyPrefix: `music/${GUILD}/${job.id}/`, maxChunkBytes: 4 * 1024 * 1024, expiresInSeconds: 1_800,
          },
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

  describe('a live stream', () => {
    /** Alice's helper has taken a job and found that it is a live stream. */
    const streaming = async () => {
      const token = await setUp(ALICE, 'Alice');
      const job = await board.post(GUILD, 'ytsearch1:lofi hip hop radio', clock());
      await post('/poll', { token });
      expect((await post('/report', { token, jobId: job.id, kind: 'found', videoId: 'rFZHOHl-L8A', title: 'lofi hip hop radio', live: true })).body).toEqual({ ok: true });
      return { token, job };
    };

    it('is sent for as long as the bot says it is listening, and stopped once it has not for a while', async () => {
      const { token, job } = await streaming();
      // Being found counts as the first "listening": the bot has a while to start playing it.
      expect(await board.get(GUILD, job.id)).toMatchObject({ track: { live: true }, listenedAt: clock() });
      clock.advance(UNHEARD_MS - 1_000);
      expect((await post('/report', { token, jobId: job.id, kind: 'progress', chunks: 5 })).body).toEqual({ ok: true });
      await board.listening(GUILD, job.id, clock());
      clock.advance(UNHEARD_MS - 1_000);
      expect((await post('/report', { token, jobId: job.id, kind: 'progress', chunks: 9 })).body).toEqual({ ok: true });

      // The call ended without saying so: nobody is listening, and the helper is told to stop.
      clock.advance(2_000);
      expect((await post('/report', { token, jobId: job.id, kind: 'progress', chunks: 12 })).body).toEqual({ ok: false });
      expect(await board.get(GUILD, job.id)).toMatchObject({ status: 'failed', error: 'nobody was listening any more', chunks: 9 });
    });

    it('is the only kind of job that has to be listened to: a song fetched ahead of its turn is not stopped', async () => {
      const token = await setUp(ALICE, 'Alice');
      const job = await board.post(GUILD, 'ytsearch1:a three hour mix', clock());
      await post('/poll', { token });
      await post('/report', { token, jobId: job.id, kind: 'found', videoId: 'oWqAf4eex14', title: 'a three hour mix' });
      expect(await board.get(GUILD, job.id)).toMatchObject({ listenedAt: null });
      clock.advance(10 * 60_000);
      expect((await post('/report', { token, jobId: job.id, kind: 'progress', chunks: 400 })).body).toEqual({ ok: true });
    });

    it('gives its helper a new upload form while it is going, and nobody else', async () => {
      const { token, job } = await streaming();
      const sam = await setUp(SAM, 'Sam');
      const issued = store.issued;
      clock.advance(20 * 60_000);
      await board.listening(GUILD, job.id, clock());
      expect((await post('/upload', { token, jobId: job.id })).body).toEqual({
        upload: { url: 'https://bucket.example/', fields: { policy: 'memory' }, keyPrefix: `music/${GUILD}/${job.id}/`, maxChunkBytes: 4 * 1024 * 1024, expiresInSeconds: 1_800 },
      });
      expect(store.issued).toBe(issued + 1);
      expect((await post('/upload', { token: sam, jobId: job.id })).body).toEqual({ upload: null });
      expect((await post('/upload', { token, jobId: 'no-such-job' })).body).toEqual({ upload: null });
      expect((await post('/upload', { token })).status).toBe(400);

      // Not once nobody is listening, and not once it is over.
      clock.advance(UNHEARD_MS + 1_000);
      expect((await post('/upload', { token, jobId: job.id })).body).toEqual({ upload: null });
      expect(await board.get(GUILD, job.id)).toMatchObject({ status: 'failed', error: 'nobody was listening any more' });
      expect(store.issued).toBe(issued + 1);
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

    it('says it is listening to a live stream for as long as it plays, and stops saying so when it is closed', async () => {
      const token = await running();
      let job!: { id: string };
      inMs(500, async () => {
        job = await take(token);
        await post('/report', { token, jobId: job.id, kind: 'found', videoId: 'rFZHOHl-L8A', title: 'lofi hip hop radio', live: true });
        upload(job, 0, 'one ');
        await post('/report', { token, jobId: job.id, kind: 'progress', chunks: 1 });
      });
      const track = (await source.resolve('lofi hip hop radio'))!;
      expect(track).toMatchObject({ title: 'lofi hip hop radio', handle: job.id });
      expect(track.durationSeconds).toBeUndefined();

      // The stream comes in a part every five seconds, for two minutes: longer than it would be left unheard.
      for (let part = 1; part <= 24; part++) {
        inMs(part * 5_000, async () => {
          upload(job, part, `${part} `);
          expect((await post('/report', { token, jobId: job.id, kind: 'progress', chunks: part + 1 })).body).toEqual({ ok: true });
        });
      }
      const stream = await source.open(track);
      const heard: string[] = [];
      const listenedAt: number[] = [];
      for await (const chunk of stream) {
        heard.push(String(chunk));
        const at = (await board.get(GUILD, job.id))!.listenedAt!;
        if (listenedAt.at(-1) !== at) listenedAt.push(at);
        if (heard.length === 25) break; // skipped: the stream is closed
      }
      expect(heard.join('')).toBe(`one ${Array.from({ length: 24 }, (_, index) => `${index + 1} `).join('')}`);
      // Said at once, then every twenty seconds.
      expect(listenedAt.length).toBeGreaterThanOrEqual(6);
      expect(listenedAt.slice(1).map((at, index) => at - listenedAt[index]!)).toEqual(Array(listenedAt.length - 1).fill(LISTENING_EVERY_MS));
      // Closed: it says so no more, and what stops the helper is the track leaving the queue.
      await settle();
      expect(repeating.every((timer) => timer.stopped)).toBe(true);
      const at = clock();
      await settle();
      expect(clock()).toBe(at); // and it has stopped looking for more
      await source.discard(track);
      expect((await post('/report', { token, jobId: job.id, kind: 'progress', chunks: 26 })).body).toEqual({ ok: false });
    });

    it('asks again for a song that was given up on while it waited its turn, and lets go of the right one afterwards', async () => {
      const token = await running();
      let first!: { id: string };
      inMs(500, async () => {
        first = await take(token);
        await post('/report', { token, jobId: first.id, kind: 'found', videoId: 'rFZHOHl-L8A', title: 'lofi hip hop radio', live: true });
      });
      const track = (await source.resolve('lofi hip hop radio'))!;
      // It waits in the queue behind other songs: nobody listens, so its helper is told to stop.
      clock.advance(UNHEARD_MS + 1_000);
      await post('/poll', { token });
      expect((await post('/report', { token, jobId: first.id, kind: 'progress', chunks: 30 })).body).toEqual({ ok: false });

      // Its turn comes: it is fetched afresh, from where the stream is now.
      let second!: { id: string; target: string };
      inMs(500, async () => {
        second = await take(token);
        await post('/report', { token, jobId: second.id, kind: 'found', videoId: 'rFZHOHl-L8A', title: 'lofi hip hop radio', live: true });
        upload(second, 0, 'live now');
        await post('/report', { token, jobId: second.id, kind: 'progress', chunks: 1 });
      });
      const stream = await source.open(track);
      expect(second.target).toBe('https://www.youtube.com/watch?v=rFZHOHl-L8A');
      expect(second.id).not.toBe(first.id);
      expect(track.handle).toBe(second.id);
      for await (const chunk of stream) {
        expect(String(chunk)).toBe('live now');
        break;
      }
      await source.discard(track);
      expect(await board.get(GUILD, second.id)).toMatchObject({ status: 'failed', error: 'no longer wanted' });
    });

    it('explains a live stream its helper has no way to fetch', async () => {
      const token = await running();
      inMs(500, async () => post('/report', { token, jobId: (await take(token)).id, kind: 'failed', error: LIVE_NEEDS_FFMPEG }));
      await expect(source.resolve('lofi hip hop radio')).rejects.toThrow(
        `That's a live stream, and Alice's music helper has no ffmpeg, which fetching one takes. How to add it: ${GUIDE}`,
      );
      // A helper from before live streams passes on what yt-dlp said.
      await post('/poll', { token });
      inMs(500, async () =>
        post('/report', { token, jobId: (await take(token)).id, kind: 'failed', error: 'm3u8 download detected but ffmpeg could not be found. Please install' }),
      );
      await expect(source.resolve('lofi hip hop radio')).rejects.toThrow(
        `That's a live stream, and Alice's music helper is too old to play those. The newer one is here: ${GUIDE}`,
      );
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
