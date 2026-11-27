import { Transform, type TransformCallback } from 'node:stream';

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
