import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { StereoToMono, monoBytesFor, readAhead, rechunk } from '../../src/voice/audio.js';

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

function stereo(pairs: Array<[number, number]>): Buffer {
  const buffer = Buffer.alloc(pairs.length * 4);
  pairs.forEach(([l, r], i) => {
    buffer.writeInt16LE(l, i * 4);
    buffer.writeInt16LE(r, i * 4 + 2);
  });
  return buffer;
}

describe('StereoToMono', () => {
  it('averages channels, including frames split across chunks', async () => {
    const input = stereo([[100, 300], [-1000, 1000], [32767, 32767], [-32768, -32768]]);
    const parts = [input.subarray(0, 3), input.subarray(3, 9), input.subarray(9)];
    const mono = Buffer.concat(await collect(Readable.from(parts).pipe(new StereoToMono())));
    expect(mono.length).toBe(8);
    expect([0, 1, 2, 3].map((i) => mono.readInt16LE(i * 2))).toEqual([200, 0, 32767, -32768]);
  });
});

describe('rechunk', () => {
  it('emits fixed-size chunks and a final remainder', async () => {
    async function* source() {
      yield Buffer.alloc(3, 1);
      yield Buffer.alloc(10, 2);
      yield Buffer.alloc(1, 3);
    }
    const chunks = await collect(rechunk(source(), 4));
    expect(chunks.map((c) => c.length)).toEqual([4, 4, 4, 2]);
    expect(Buffer.concat(chunks).length).toBe(14);
  });

  it('sizes 100 ms of 48 kHz mono 16-bit PCM', () => {
    expect(monoBytesFor(100)).toBe(9_600);
  });
});

describe('readAhead (audio that is still arriving)', () => {
  /** A source fed by hand, the way bytes come off the network. */
  const arriving = () => {
    const source = new Readable({ read: () => undefined });
    return { source, send: (bytes: number) => source.push(Buffer.alloc(bytes, 7)), finish: () => source.push(null) };
  };
  const settled = async (promise: Promise<unknown>) => {
    let done = false;
    void promise.then(() => (done = true), () => (done = true));
    await new Promise((resolve) => setImmediate(resolve));
    return done;
  };

  it('is ready once the head of it is in hand, and plays the rest as it comes', async () => {
    const { source, send, finish } = arriving();
    const ready = readAhead(source, 1_000);
    send(600);
    expect(await settled(ready)).toBe(false);
    send(600);
    const audio = await ready;
    // The rest arrives while it plays.
    send(800);
    finish();
    expect(Buffer.concat(await collect(audio)).length).toBe(2_000);
  });

  it('is ready with all of it when there is less than a head', async () => {
    const { source, send, finish } = arriving();
    const ready = readAhead(source, 1_000);
    send(300);
    finish();
    expect(Buffer.concat(await collect(await ready)).length).toBe(300);
  });

  it('takes everything in as it arrives, so a piece waiting its turn does not hold its source up', async () => {
    const megabyte = Buffer.alloc(1024 * 1024, 7);
    let sent = 0;
    const source = new Readable({
      read() {
        // Sends only as fast as it is read from: this finishes only if nothing slows it down.
        this.push(sent++ < 8 ? megabyte : null);
      },
    });
    const audio = await readAhead(source, 1_000);
    await finished(source);
    // Nobody has read any of it yet, and all eight megabytes are there.
    expect(audio.readableLength).toBe(8 * 1024 * 1024);
    audio.destroy();
  });

  it('fails if the source fails before there is anything to play, and passes a later failure on', async () => {
    const early = arriving();
    const never = readAhead(early.source, 1_000);
    early.send(100);
    early.source.destroy(new Error('the connection dropped'));
    await expect(never).rejects.toThrow('the connection dropped');

    const late = arriving();
    const ready = readAhead(late.source, 1_000);
    late.send(1_500);
    const audio = await ready;
    late.source.destroy(new Error('the connection dropped'));
    await expect(collect(audio)).rejects.toThrow('the connection dropped');
  });

  it('stops the source when what it returned is thrown away', async () => {
    const { source, send } = arriving();
    const ready = readAhead(source, 1_000);
    send(1_500);
    (await ready).destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(source.destroyed).toBe(true);
  });
});
