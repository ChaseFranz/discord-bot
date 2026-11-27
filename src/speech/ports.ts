import type { Readable } from 'node:stream';

/** Raw PCM audio description. Discord audio is decoded to 48 kHz; we downmix to mono. */
export interface PcmFormat {
  encoding: 'pcm_s16le';
  sampleRate: number;
  channels: 1;
}

/** Optional callbacks while one utterance is being transcribed. */
export interface TranscriptionHooks {
  /** The transcript so far, while the person is still talking. It can still change. */
  onPartial?(text: string): void;
}

/**
 * Speech-to-text port. Implementations: AWS Transcribe streaming (today). Others (local
 * Whisper, Deepgram, ...) can be added without touching the voice pipeline.
 */
export interface SpeechToText {
  /**
   * Transcribes one utterance. `audio` yields PCM chunks as they are captured, so streaming
   * implementations can start before the speaker has finished. Resolves to the transcript
   * ('' when nothing intelligible was said).
   */
  transcribe(audio: AsyncIterable<Buffer>, format: PcmFormat, signal?: AbortSignal, hooks?: TranscriptionHooks): Promise<string>;
}

export interface SynthesizedSpeech {
  /** Encoded audio (any container/codec ffmpeg can read). */
  audio: Readable;
  /** Container/codec of `audio`, e.g. 'mp3'. */
  format: 'mp3' | 'ogg_vorbis' | 'pcm';
}

/** Text-to-speech port. Implementations: AWS Polly (today). */
export interface TextToSpeech {
  synthesize(text: string, signal?: AbortSignal): Promise<SynthesizedSpeech>;
}
