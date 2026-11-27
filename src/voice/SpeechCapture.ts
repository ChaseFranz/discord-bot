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

export interface CaptureContext {
  receiver: VoiceReceiver;
  userId: string;
  stt: SpeechToText;
  options: CaptureOptions;
  clock: Clock;
  logger: Logger;
  /** Aborting stops listening and cancels the transcription; the capture then resolves to null. */
  signal?: AbortSignal;
  /** Told how many seconds of audio were streamed to speech-to-text (what it bills for). */
  onAudioSent?: (seconds: number) => void;
}

const CHUNK_MS = 100;
const BYTES_PER_SECOND = DISCORD_SAMPLE_RATE * 2;

/**
 * Captures one utterance from a person and transcribes it while it is still being spoken:
 * Opus packets -> PCM (48 kHz stereo) -> mono -> ~100 ms chunks -> speech-to-text stream.
 * Resolves to null for noise (too short), when nothing intelligible was said, or when aborted.
 */
export async function captureUtterance(context: CaptureContext): Promise<CapturedUtterance | null> {
  const { receiver, userId, stt, options, clock, logger, signal } = context;
  if (signal?.aborted) return null;
  const startedAt = clock();
  const opus = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: options.silenceMs },
  });
  const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: DISCORD_SAMPLE_RATE });
  const mono = new StereoToMono();

  const endInput = () => {
    if (!opus.readableEnded && !opus.destroyed) opus.push(null);
  };
  const capTimer = setTimeout(endInput, options.maxUtteranceMs);
  signal?.addEventListener('abort', endInput, { once: true });
  const piped = pipeline(opus, decoder, mono).catch((error: unknown) => {
    logger.debug(`Audio pipeline for ${userId} ended with an error: ${describeError(error)}`);
    mono.end();
  });

  let bytesSent = 0;
  try {
    const chunks = rechunk(mono, monoBytesFor(CHUNK_MS))[Symbol.asyncIterator]();

    // Hold back the first few hundred ms: coughs and clicks end before this and cost nothing.
    const head: Buffer[] = [];
    let headBytes = 0;
    const minBytes = monoBytesFor(options.minSpeechMs);
    while (headBytes < minBytes) {
      const next = await chunks.next();
      if (next.done || signal?.aborted) return null;
      head.push(next.value);
      headBytes += next.value.length;
    }

    async function* audio(): AsyncGenerator<Buffer> {
      for (const chunk of head) {
        bytesSent += chunk.length;
        yield chunk;
      }
      for (;;) {
        const next = await chunks.next();
        if (next.done || signal?.aborted) return;
        bytesSent += next.value.length;
        yield next.value;
      }
    }

    let text: string;
    try {
      text = await stt.transcribe(audio(), { encoding: 'pcm_s16le', sampleRate: DISCORD_SAMPLE_RATE, channels: 1 }, signal);
    } catch (error) {
      if (signal?.aborted) return null;
      throw error;
    }
    if (signal?.aborted) return null;
    const endedAt = clock();
    return text.length > 0 ? { userId, text, startedAt, endedAt } : null;
  } finally {
    clearTimeout(capTimer);
    signal?.removeEventListener('abort', endInput);
    if (!opus.destroyed) opus.destroy();
    await piped;
    if (bytesSent > 0) context.onAudioSent?.(bytesSent / BYTES_PER_SECOND);
  }
}
