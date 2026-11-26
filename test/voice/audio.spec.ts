import { Readable } from 'node:stream';
import { StereoToMono, monoBytesFor, rechunk } from '../../src/voice/audio.js';

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
