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
  /**
   * The audio. It may still be arriving: implementations hand it over as soon as the first of it
   * is there, so it can start playing while the rest is synthesised.
   */
  audio: Readable;
  /**
   * Container/codec of `audio`. 'ogg_opus' means Ogg-wrapped Opus at 48 kHz in 20 ms packets,
   * which is what Discord plays: it is passed on as it is. Anything else is decoded with ffmpeg.
   */
  format: 'ogg_opus' | 'mp3' | 'ogg_vorbis' | 'pcm';
}

/**
 * Speech for text that is still being written: text goes in as it comes, and one continuous run
 * of audio comes out as it is made, so that the sentences of a reply flow into one another.
 */
export interface SpeechStream {
  /**
   * Adds text after what was added before (separate pieces need their own spacing). With `flush`,
   * everything so far is spoken now; otherwise the speaker may wait to see what follows, which
   * makes for better phrasing.
   */
  write(text: string, flush?: boolean): void;
  /** No more text: what is left is spoken, and then the audio ends. */
  end(): void;
  /** Stops at once. No more audio comes. */
  abort(): void;
  /** Ogg Opus at 48 kHz, one stream for everything written. It fails if the speech stream does. */
  readonly audio: Readable;
}

/** Text-to-speech port. Implementations: AWS Polly (today). */
export interface TextToSpeech {
  /** Resolves once audio has started to arrive (see SynthesizedSpeech.audio). */
  synthesize(text: string, signal?: AbortSignal): Promise<SynthesizedSpeech>;
  /** A stream for one reply (see SpeechStream), where this implementation offers one right now. */
  openStream?(): SpeechStream | undefined;
}
