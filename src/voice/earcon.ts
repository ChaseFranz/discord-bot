import { DISCORD_SAMPLE_RATE } from './audio.js';

interface Note {
  frequency: number;
  startMs: number;
  durationMs: number;
  gain: number;
}

/** Two soft bell tones a fifth apart (A5 then E6): short, bright, and easy to hear over a call. */
const WAKE_NOTES: readonly Note[] = [
  { frequency: 880.0, startMs: 0, durationMs: 170, gain: 0.8 },
  { frequency: 1318.51, startMs: 95, durationMs: 300, gain: 1.0 },
];
const WAKE_TOTAL_MS = 420;
/** Peak level: about -10 dBFS, a little quieter than speech. */
const WAKE_PEAK = 0.32;

/**
 * Renders the "I heard you, working on it" chime as 48 kHz, 16-bit, stereo PCM (Discord's native
 * format), so it plays immediately without spawning ffmpeg.
 */
export function renderWakeChime(): Buffer {
  return renderNotes(WAKE_NOTES, WAKE_TOTAL_MS, WAKE_PEAK);
}

function renderNotes(notes: readonly Note[], totalMs: number, peak: number): Buffer {
  const rate = DISCORD_SAMPLE_RATE;
  const frames = Math.round((rate * totalMs) / 1000);
  const mono = new Float64Array(frames);

  for (const note of notes) {
    const start = Math.round((note.startMs * rate) / 1000);
    const length = Math.round((note.durationMs * rate) / 1000);
    const fadeFrames = 0.02 * rate;
    for (let i = 0; i < length && start + i < frames; i++) {
      const t = i / rate;
      const attack = Math.min(1, t / 0.006); // 6 ms soft attack, no click
      const decay = Math.exp(-t / 0.09); // bell-like decay
      const release = Math.min(1, (length - i) / fadeFrames); // 20 ms fade to silence
      const phase = 2 * Math.PI * note.frequency * t;
      // A touch of the 2nd and 3rd harmonics makes it sound like a chime rather than a beep.
      const tone = Math.sin(phase) + 0.22 * Math.sin(2 * phase) + 0.06 * Math.sin(3 * phase);
      mono[start + i]! += attack * decay * release * note.gain * tone;
    }
  }

  let max = 0;
  for (const sample of mono) max = Math.max(max, Math.abs(sample));
  const scale = max > 0 ? peak / max : 0;

  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const value = Math.round(Math.max(-1, Math.min(1, mono[i]! * scale)) * 32767);
    pcm.writeInt16LE(value, i * 4);
    pcm.writeInt16LE(value, i * 4 + 2);
  }
  return pcm;
}
