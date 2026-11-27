import { PassThrough, Transform, pipeline, type Readable, type TransformCallback } from 'node:stream';

/** Discord voice audio decodes to 48 kHz, 16-bit, stereo PCM. */
export const DISCORD_SAMPLE_RATE = 48_000;
const BYTES_PER_SAMPLE = 2;

/** Bytes of mono 16-bit PCM covering `ms` milliseconds at `sampleRate`. */
export function monoBytesFor(ms: number, sampleRate = DISCORD_SAMPLE_RATE): number {
  return Math.round((sampleRate * ms) / 1000) * BYTES_PER_SAMPLE;
}

/**
 * Downmixes interleaved 16-bit little-endian stereo PCM to mono by averaging the channels.
 * Handles frames split across chunk boundaries.
 */
export class StereoToMono extends Transform {
  private remainder: Buffer = Buffer.alloc(0);

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const input = this.remainder.length > 0 ? Buffer.concat([this.remainder, chunk]) : chunk;
    const frames = Math.floor(input.length / 4);
    const output = Buffer.allocUnsafe(frames * 2);
    for (let i = 0; i < frames; i++) {
      const left = input.readInt16LE(i * 4);
      const right = input.readInt16LE(i * 4 + 2);
      output.writeInt16LE((left + right) >> 1, i * 2);
    }
    this.remainder = Buffer.from(input.subarray(frames * 4));
    callback(null, output);
  }

  override _flush(callback: TransformCallback): void {
    this.remainder = Buffer.alloc(0);
    callback();
  }
}

/**
 * Regroups a byte stream into chunks of exactly `size` bytes (the last may be shorter).
 * Streaming STT services prefer steady ~100 ms frames over Discord's 20 ms packets.
 */
/** More than any one piece of speech comes to: what readAhead will hold without slowing its source. */
const READ_AHEAD_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * Makes audio that is still arriving over the network safe to play as it comes.
 *
 * Resolves once `headBytes` of it are in hand (or all of it, if there is less), so playback does
 * not start on a trickle and stumble over the first hiccup. From then on everything that arrives
 * is kept in memory straight away: audio is played in real time, and a piece may wait seconds for
 * its turn, and neither should hold up whoever is sending it.
 *
 * Rejects if the source fails before that. If it fails later, the returned stream fails with it.
 * Destroying the returned stream stops the source.
 */
export function readAhead(source: Readable, headBytes: number): Promise<Readable> {
  const held = new PassThrough({ highWaterMark: READ_AHEAD_LIMIT_BYTES });
  // A failure after playback was abandoned has nobody left to tell.
  held.on('error', () => undefined);
  return new Promise((resolve, reject) => {
    let settled = false;
    let received = 0;
    const ready = () => {
      if (settled) return;
      settled = true;
      resolve(held);
    };
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received >= headBytes) ready();
    });
    pipeline(source, held, (error) => {
      if (error && !settled) {
        settled = true;
        reject(error);
      } else {
        ready();
      }
    });
  });
}

export async function* rechunk(source: AsyncIterable<Buffer>, size: number): AsyncGenerator<Buffer> {
  if (size <= 0) throw new RangeError('size must be positive');
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  for await (const chunk of source) {
    pending.push(chunk);
    pendingBytes += chunk.length;
    if (pendingBytes < size) continue;
    let all = Buffer.concat(pending, pendingBytes);
    while (all.length >= size) {
      yield all.subarray(0, size);
      all = all.subarray(size);
    }
    pending = all.length > 0 ? [all] : [];
    pendingBytes = all.length;
  }
  if (pendingBytes > 0) yield Buffer.concat(pending, pendingBytes);
}
