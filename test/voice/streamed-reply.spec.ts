import { PassThrough, Readable } from 'node:stream';
import type { SpeechStream } from '../../src/speech/ports.js';
import { StreamedReply } from '../../src/voice/StreamedReply.js';
import { silentLogger } from '../helpers.js';

/**
 * The splitter on made-up audio: each packet is 20 ms, and says whether it is sound or silence
 * (its first byte) and which packet it is (the rest), so where each piece was cut can be checked.
 */
const SOUND = 1;
const QUIET = 0;
const packet = (kind: number, index: number) => Buffer.from([kind, index & 255, index >> 8]);
const indexOf = (packet: Buffer) => packet[1]! + (packet[2]! << 8);

/** Audio as runs: [kind, how many 20 ms frames]. */
function audioOf(...runs: Array<[number, number]>): Buffer[] {
  const out: Buffer[] = [];
  for (const [kind, frames] of runs) for (let n = 0; n < frames; n++) out.push(packet(kind, out.length));
  return out;
}

function setup(options: { stallMs?: number } = {}) {
  const written: Array<{ text: string; flush: boolean }> = [];
  const state = { ended: false, aborted: false, closed: 0 };
  const audio = new PassThrough({ objectMode: true });
  const stream: SpeechStream = {
    write: (text, flush = false) => void written.push({ text, flush }),
    end: () => void (state.ended = true),
    abort: () => {
      state.aborted = true;
      audio.destroy();
    },
    audio,
  };
  const fallbacks: string[] = [];
  const reply = new StreamedReply<Readable>(stream, {
    wrap: (packets) => packets,
    fallback: async (text) => {
      fallbacks.push(text);
      return Readable.from([Buffer.from(`on its own: ${text}`)]);
    },
    logger: silentLogger(),
    closed: () => void state.closed++,
    // The test hands over packets itself, and says how loud each is.
    packetsOf: (bytes) => bytes,
    levelOf: (packet) => (packet[0] === SOUND ? 0.1 : 0),
    stallMs: options.stallMs ?? 10_000,
  });
  const send = (packets: Buffer[]) => {
    for (const one of packets) audio.write(one);
  };
  return { reply, written, state, audio, send, fallbacks };
}

const collect = async (stream: Readable) => {
  const out: Buffer[] = [];
  for await (const chunk of stream) out.push(chunk as Buffer);
  return out;
};
const settled = async (promise: Promise<unknown>) => {
  let done = false;
  void promise.then(() => (done = true), () => (done = true));
  for (let round = 0; round < 5; round++) await new Promise((resolve) => setImmediate(resolve));
  return done;
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Forty characters each: at the starting rate of 0.05 s a character, two seconds (100 frames) apiece.
const FIRST = 'Sure, it is about sixty-two degrees now.';
const SECOND = 'Tomorrow looks a little warmer, I think.';
const THIRD = 'Want a reminder?';

describe('StreamedReply', () => {
  it('cuts a reply where its sentences end, skipping a comma pause early on, and loses no audio', async () => {
    const { reply, send, written, state, audio: stream } = setup();
    const pieces = [reply.piece(FIRST), reply.piece(SECOND), reply.piece(THIRD)];
    const audio = audioOf(
      [QUIET, 3], [SOUND, 10], // "Sure,"
      [QUIET, 12], // a comma pause early on: not an end
      [SOUND, 75],
      [QUIET, 20], // the first sentence ends (frames 100 to 119)
      [SOUND, 40],
      [QUIET, 8], // a short comma pause
      [SOUND, 50],
      [QUIET, 20], // the second ends (218 to 237)
      [SOUND, 35],
      [QUIET, 3],
    );
    send(audio);
    reply.end();
    stream.end();

    const heard = await Promise.all(pieces.map(async (get) => (await collect(await get())).map(indexOf)));
    // Cut in the middle of each sentence's pause; the third has the rest.
    expect(heard.map((frames) => [frames[0], frames.at(-1)])).toEqual([[0, 106], [107, 224], [225, 275]]);
    expect(heard.flat()).toEqual(audio.map(indexOf));
    // The first is spoken at once; the others wait to see what follows them.
    expect(written).toEqual([
      { text: FIRST, flush: true },
      { text: ` ${SECOND}`, flush: false },
      { text: ` ${THIRD}`, flush: false },
    ]);
    expect(state.ended).toBe(true);
    expect(state.closed).toBe(1);
  });

  it('has the first piece ready after a few packets, while the rest of it is still on its way', async () => {
    const { reply, send } = setup();
    const first = reply.piece(FIRST)();
    send(audioOf([SOUND, 3]));
    expect(await settled(first)).toBe(false);
    send(audioOf([SOUND, 3]));
    expect(await settled(first)).toBe(true);
  });

  it('asks Polly to speak what it has when nothing more is written for a moment', async () => {
    const { reply, written } = setup({ stallMs: 20 });
    reply.piece(FIRST);
    reply.piece(SECOND);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(written.at(-1)).toEqual({ text: '', flush: true });
    // Once is enough, and none after the end.
    reply.piece(THIRD);
    reply.end();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(written.filter((write) => write.flush && write.text === '')).toHaveLength(1);
  });

  it('takes the longest pause there is when none is long enough, once it has heard enough', async () => {
    const { reply, send, audio } = setup();
    const [first, second] = [reply.piece(FIRST), reply.piece(SECOND)];
    send(audioOf([SOUND, 64], [QUIET, 5], [SOUND, 46], [QUIET, 8], [SOUND, 52]));
    // 175 frames have come (the most the first could take): the longer pause, 115 to 122, is where it ended.
    const firstFrames = (await collect(await first())).map(indexOf);
    expect(firstFrames.at(-1)).toBe(118);
    reply.end();
    audio.end();
    expect((await collect(await second()))[0]).toEqual(packet(QUIET, 119));
  });

  it('decides with what it has when the piece playing is about to run out', async () => {
    const { reply, send } = setup();
    const first = reply.piece(FIRST);
    reply.piece(SECOND);
    // Polly is slow: only 86 frames so far, with one short pause after the point where an end could be.
    send(audioOf([SOUND, 70], [QUIET, 6], [SOUND, 10]));
    const frames = (await collect(await first())).map(indexOf);
    expect(frames.at(-1)).toBe(72);
  });

  it('speaks the rest a piece at a time if the stream fails, ending what is under way where it was', async () => {
    const { reply, send, audio, fallbacks } = setup();
    const first = reply.piece(FIRST);
    const second = reply.piece(SECOND);
    send(audioOf([SOUND, 20]));
    await settle();
    audio.destroy(new Error('the connection dropped'));
    await settle();
    expect((await collect(await first())).length).toBe(20);
    expect((await collect(await second())).map(String)).toEqual([`on its own: ${SECOND}`]);
    // And anything written after that.
    expect((await collect(await reply.piece(THIRD)())).map(String)).toEqual([`on its own: ${THIRD}`]);
    expect(fallbacks).toEqual([SECOND, THIRD]);
  });

  it('speaks every piece on its own when the stream fails before any audio (Polly refused, say)', async () => {
    const { reply, audio, fallbacks } = setup();
    const pieces = [reply.piece(FIRST), reply.piece(SECOND)];
    audio.destroy(new Error('AccessDeniedException'));
    await settle();
    for (const get of pieces) await collect(await get());
    expect(fallbacks).toEqual([FIRST, SECOND]);
  });

  it('stops the stream when cancelled, and settles whatever was waiting', async () => {
    const { reply, send, state } = setup();
    const first = reply.piece(FIRST);
    const second = reply.piece(SECOND);
    send(audioOf([SOUND, 10]));
    reply.cancel();
    expect(state.aborted).toBe(true);
    expect(state.closed).toBe(1);
    expect(await settled(second())).toBe(true);
    expect(await collect(await second())).toEqual([]);
    await first();
  });
});
