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
  silenceMs: 600,
  minSpeechMs: 400,
  maxUtteranceMs: 30_000,
};

export interface CapturedUtterance {
  userId: string;
  text: string;
  /** When they started talking. */
  startedAt: number;
  /** When the last of their audio arrived: the moment they stopped talking. */
  lastAudioAt: number;
  /** When the transcript was ready. */
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
  /**
   * Asked again and again while they talk: may this person still be listened to? They may opt out
   * mid-sentence, and where the bot runs as several processes that is only found out by asking.
   * The first "no" stops the capture there, as an abort would. Not being able to ask is not a no.
   */
  stillAllowed?: () => boolean | Promise<boolean>;
  /** How often `stillAllowed` is asked (default RECHECK_ALLOWED_MS). */
  recheckMs?: number;
  /** Told how many seconds of audio were streamed to speech-to-text (what it bills for). */
  onAudioSent?: (seconds: number) => void;
  /** Called as audio arrives, with how much this utterance holds so far: they are talking right now. */
  onAudio?: (audioMs: number) => void;
  /** The transcript so far, before they have finished. */
  onPartial?: (text: string) => void;
}

/** How often a capture asks whether its speaker may still be listened to. */
export const RECHECK_ALLOWED_MS = 1_000;
const CHUNK_MS = 100;
const BYTES_PER_SECOND = DISCORD_SAMPLE_RATE * 2;

/**
 * Captures one utterance from a person and transcribes it while it is still being spoken:
 * Opus packets -> PCM (48 kHz stereo) -> mono -> ~100 ms chunks -> speech-to-text stream.
 * Resolves to null for noise (too short), when nothing intelligible was said, or when aborted.
 */
export async function captureUtterance(context: CaptureContext): Promise<CapturedUtterance | null> {
  const { receiver, userId, stt, options, clock, logger } = context;
  if (context.signal?.aborted) return null;
  // Listening ends when the caller says so, or when asking whether they may still be listened to gets a no.
  const withdrawn = new AbortController();
  const signal = context.signal ? AbortSignal.any([context.signal, withdrawn.signal]) : withdrawn.signal;
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
  signal.addEventListener('abort', endInput, { once: true });
  let asking = false;
  const recheck = context.stillAllowed
    ? setInterval(() => {
        if (asking || signal.aborted) return;
        asking = true;
        void Promise.resolve()
          .then(() => context.stillAllowed!())
          .then((allowed) => {
            if (!allowed) withdrawn.abort();
          })
          // They were allowed a moment ago, and the next ask may get through.
          .catch((error: unknown) => logger.warn(`Could not ask whether ${userId} may still be listened to: ${describeError(error)}`))
          .finally(() => {
            asking = false;
          });
      }, context.recheckMs ?? RECHECK_ALLOWED_MS)
    : undefined;
  const piped = pipeline(opus, decoder, mono).catch((error: unknown) => {
    logger.debug(`Audio pipeline for ${userId} ended with an error: ${describeError(error)}`);
    mono.end();
  });
  // When the last of their audio arrived. (Not when it was passed on: the tail of an utterance is
  // only passed on once the silence after it has been waited out.)
  let lastAudioAt = startedAt;
  opus.on('data', () => {
    lastAudioAt = clock();
  });

  let bytesSent = 0;
  let bytesHeard = 0;
  const heard = (chunk: Buffer) => {
    bytesHeard += chunk.length;
    context.onAudio?.((bytesHeard / BYTES_PER_SECOND) * 1000);
  };
  try {
    const chunks = rechunk(mono, monoBytesFor(CHUNK_MS))[Symbol.asyncIterator]();

    // Hold back the first few hundred ms: coughs and clicks end before this and cost nothing.
    const head: Buffer[] = [];
    let headBytes = 0;
    const minBytes = monoBytesFor(options.minSpeechMs);
    while (headBytes < minBytes) {
      const next = await chunks.next();
      if (next.done || signal.aborted) return null;
      heard(next.value);
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
        if (next.done || signal.aborted) return;
        heard(next.value);
        bytesSent += next.value.length;
        yield next.value;
      }
    }

    let text: string;
    try {
      text = await stt.transcribe(audio(), { encoding: 'pcm_s16le', sampleRate: DISCORD_SAMPLE_RATE, channels: 1 }, signal, {
        onPartial: (partial) => {
          if (!signal.aborted) context.onPartial?.(partial);
        },
      });
    } catch (error) {
      if (signal.aborted) return null;
      throw error;
    }
    if (signal.aborted) return null;
    const endedAt = clock();
    return text.length > 0 ? { userId, text, startedAt, lastAudioAt, endedAt } : null;
  } finally {
    clearTimeout(capTimer);
    clearInterval(recheck);
    signal.removeEventListener('abort', endInput);
    if (!opus.destroyed) opus.destroy();
    await piped;
    if (bytesSent > 0) context.onAudioSent?.(bytesSent / BYTES_PER_SECOND);
  }
}
