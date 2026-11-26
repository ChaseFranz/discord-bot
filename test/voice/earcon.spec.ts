import { renderWakeChime } from '../../src/voice/earcon.js';

describe('renderWakeChime', () => {
  const pcm = renderWakeChime();
  const frames = pcm.length / 4;
  const left = (i: number) => pcm.readInt16LE(i * 4);
  const right = (i: number) => pcm.readInt16LE(i * 4 + 2);

  it('is a short clip in Discord format (48 kHz, 16-bit, stereo)', () => {
    expect(pcm.length % 4).toBe(0);
    expect((frames / 48_000) * 1000).toBeCloseTo(420, 0);
  });

  it('is the same in both ears', () => {
    for (let i = 0; i < frames; i += 97) expect(right(i)).toBe(left(i));
  });

  it('peaks around -10 dBFS so it is softer than speech, and starts and ends silent (no clicks)', () => {
    let peak = 0;
    for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(left(i)));
    expect(peak / 32767).toBeCloseTo(0.32, 2);
    expect(Math.abs(left(0))).toBeLessThan(200);
    expect(Math.abs(left(frames - 1))).toBeLessThan(200);
  });

  it('renders the same sound every time', () => {
    expect(renderWakeChime().equals(pcm)).toBe(true);
  });
});
