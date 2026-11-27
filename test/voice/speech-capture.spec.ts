import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { EndBehaviorType, type VoiceReceiver } from '@discordjs/voice';
import type { PcmFormat, SpeechToText, TranscriptionHooks } from '../../src/speech/ports.js';
import { DEFAULT_CAPTURE_OPTIONS, captureUtterance, type CaptureContext } from '../../src/voice/SpeechCapture.js';
import { silentLogger } from '../helpers.js';

const require = createRequire(import.meta.url);
const { OpusEncoder } = require('@discordjs/opus') as { OpusEncoder: new (rate: number, channels: number) => { encode(pcm: Buffer): Buffer } };

/** `count` real 20 ms Opus packets of a tone, as Discord sends them. */
function opusPackets(count: number): Buffer[] {
  const encoder = new OpusEncoder(48_000, 2);
  const frame = Buffer.alloc(960 * 4);
  for (let sample = 0; sample < 960; sample++) {
    const value = Math.round(Math.sin(sample / 10) * 8_000);
    frame.writeInt16LE(value, sample * 4);
    frame.writeInt16LE(value, sample * 4 + 2);
  }
  return Array.from({ length: count }, () => encoder.encode(frame));
}

describe('captureUtterance', () => {
  let subscriptions: Array<{ userId: string; options: unknown }>;
  let heardBySpeechToText: { bytes: number; format: PcmFormat } | undefined;
  let ticks: number;

  /** A receiver whose stream for a person is the given packets, then the end (they went quiet). */
  const receiver = (packets: Buffer[]) =>
    ({
      subscribe: (userId: string, options: unknown) => {
        subscriptions.push({ userId, options });
        return Readable.from(packets, { objectMode: true });
      },
    }) as unknown as VoiceReceiver;

  /** Speech-to-text that reads all the audio, reporting `partials` on the way, then gives `text`. */
  const stt = (text: string, partials: string[] = []): SpeechToText => ({
    transcribe: async (audio: AsyncIterable<Buffer>, format: PcmFormat, _signal?: AbortSignal, hooks?: TranscriptionHooks) => {
      let bytes = 0;
      for await (const chunk of audio) bytes += chunk.length;
      for (const partial of partials) hooks?.onPartial?.(partial);
      heardBySpeechToText = { bytes, format };
      return text;
    },
  });

  const capture = (packets: Buffer[], speechToText: SpeechToText, extra: Partial<CaptureContext> = {}) =>
    captureUtterance({
      receiver: receiver(packets),
      userId: 'u-alice',
      stt: speechToText,
      options: { ...DEFAULT_CAPTURE_OPTIONS, silenceMs: 650 },
      clock: () => ++ticks,
      logger: silentLogger(),
      ...extra,
    });

  beforeEach(() => {
    subscriptions = [];
    heardBySpeechToText = undefined;
    ticks = 0;
  });

  it('transcribes what someone said, reporting that they are talking and what they have said so far', async () => {
    const audioMs: number[] = [];
    const partials: string[] = [];
    let secondsSent = 0;
    const utterance = await capture(opusPackets(50), stt('Nimbus, hello.', ['nimbus', 'nimbus hello']), {
      onAudio: (ms) => audioMs.push(ms),
      onPartial: (text) => partials.push(text),
      onAudioSent: (seconds) => (secondsSent = seconds),
    });

    expect(utterance).toMatchObject({ userId: 'u-alice', text: 'Nimbus, hello.' });
    // Started, last heard from, transcript ready: in that order.
    expect(utterance!.startedAt).toBeLessThan(utterance!.lastAudioAt);
    expect(utterance!.lastAudioAt).toBeLessThan(utterance!.endedAt);
    // A second of audio, reported as it arrived in 100 ms steps (48 kHz mono 16-bit to speech-to-text).
    expect(audioMs).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    expect(heardBySpeechToText).toEqual({ bytes: 96_000, format: { encoding: 'pcm_s16le', sampleRate: 48_000, channels: 1 } });
    expect(secondsSent).toBe(1);
    expect(partials).toEqual(['nimbus', 'nimbus hello']);
    // The stream ends after the configured silence.
    expect(subscriptions).toEqual([{ userId: 'u-alice', options: { end: { behavior: EndBehaviorType.AfterSilence, duration: 650 } } }]);
  });

  it('treats a sound shorter than the minimum as noise: nothing is sent to speech-to-text', async () => {
    const audioMs: number[] = [];
    let sent = false;
    const utterance = await capture(opusPackets(15), stt('should not be asked'), {
      onAudio: (ms) => audioMs.push(ms),
      onAudioSent: () => (sent = true),
    });
    expect(utterance).toBeNull();
    expect(heardBySpeechToText).toBeUndefined();
    expect(sent).toBe(false);
    // It was still heard as a sound, which is what lets a short one be ignored by whoever is listening.
    expect(audioMs).toEqual([100, 200, 300]);
  });

  it('resolves to nothing when nothing intelligible was said, or when listening is cancelled', async () => {
    expect(await capture(opusPackets(50), stt(''))).toBeNull();
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await capture(opusPackets(50), stt('too late'), { signal: cancelled.signal })).toBeNull();
    expect(subscriptions).toHaveLength(1); // the cancelled one never started listening
  });
});
