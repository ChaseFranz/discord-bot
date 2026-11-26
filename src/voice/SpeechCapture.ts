import { pipeline } from 'node:stream/promises';
import { EndBehaviorType, type VoiceReceiver } from '@discordjs/voice';
import prism from 'prism-media';
import type { Logger } from '../logging/logger.js';
import { describeError } from '../logging/logger.js';
import type { SpeechToText } from '../speech/ports.js';
import type { Clock } from '../util/time.js';
import { DISCORD_SAMPLE_RATE, StereoToMono, monoBytesFor, rechunk } from './audio.js';

export interface CaptureOptions {
  /** Silence that ends an utterance. */
  silenceMs: number;
  /** Utterances with less audio than this are treated as noise and never sent to STT. */
  minSpeechMs: number;
  /** Hard cap on one utterance, so an open mic can't hold a stream forever. */
  maxUtteranceMs: number;
}

export const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = {
  silenceMs: 1_200,
  minSpeechMs: 400,
  maxUtteranceMs: 30_000,
};

export interface CapturedUtterance {
  userId: string;
  text: string;
  startedAt: number;
  endedAt: number;
}

const CHUNK_MS = 100;

/**
 * Captures one utterance from `userId` and transcribes it while it is still being spoken:
 * Opus packets -> PCM (48 kHz stereo) -> mono -> ~100 ms chunks -> speech-to-text stream.
 * Resolves to null for noise (too short) or when nothing intelligible was said.
 */
export async function captureUtterance(
  receiver: VoiceReceiver,
  userId: string,
  stt: SpeechToText,
  options: CaptureOptions,
  clock: Clock,
  logger: Logger,
): Promise<CapturedUtterance | null> {
  const startedAt = clock();
  const opus = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: options.silenceMs },
  });
  const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: DISCORD_SAMPLE_RATE });
  const mono = new StereoToMono();

  const capTimer = setTimeout(() => {
    if (!opus.readableEnded && !opus.destroyed) opus.push(null);
  }, options.maxUtteranceMs);
  const piped = pipeline(opus, decoder, mono).catch((error: unknown) => {
    logger.debug(`Audio pipeline for ${userId} ended with an error: ${describeError(error)}`);
    mono.end();
  });

  try {
    const chunks = rechunk(mono, monoBytesFor(CHUNK_MS))[Symbol.asyncIterator]();

    // Hold back the first few hundred ms: coughs and clicks end before this and cost nothing.
    const head: Buffer[] = [];
    let headBytes = 0;
    const minBytes = monoBytesFor(options.minSpeechMs);
    while (headBytes < minBytes) {
      const next = await chunks.next();
      if (next.done) return null;
      head.push(next.value);
      headBytes += next.value.length;
    }

    async function* audio(): AsyncGenerator<Buffer> {
      yield* head;
      for (;;) {
        const next = await chunks.next();
        if (next.done) return;
        yield next.value;
      }
    }

    const text = await stt.transcribe(audio(), { encoding: 'pcm_s16le', sampleRate: DISCORD_SAMPLE_RATE, channels: 1 });
    const endedAt = clock();
    return text.length > 0 ? { userId, text, startedAt, endedAt } : null;
  } finally {
    clearTimeout(capTimer);
    if (!opus.destroyed) opus.destroy();
    await piped;
  }
}
