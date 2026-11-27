import {
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
  type AudioStream,
  type LanguageCode,
} from '@aws-sdk/client-transcribe-streaming';
import type { PcmFormat, SpeechToText, TranscriptionHooks } from '../ports.js';

export interface TranscribeOptions {
  region: string;
  languageCode: string;
  client?: TranscribeStreamingClient;
}

/**
 * Speech-to-text with Amazon Transcribe streaming. One stream per utterance; Transcribe bills per
 * second of audio sent with no per-request minimum, so short utterances cost only what they last.
 */
export class TranscribeSpeechToText implements SpeechToText {
  private readonly client: TranscribeStreamingClient;
  private readonly languageCode: string;

  constructor(options: TranscribeOptions) {
    this.client = options.client ?? new TranscribeStreamingClient({ region: options.region });
    this.languageCode = options.languageCode;
  }

  async transcribe(audio: AsyncIterable<Buffer>, format: PcmFormat, signal?: AbortSignal, hooks?: TranscriptionHooks): Promise<string> {
    if (format.encoding !== 'pcm_s16le' || format.channels !== 1) {
      throw new Error('Transcribe streaming expects mono 16-bit little-endian PCM');
    }

    async function* audioEvents(): AsyncGenerator<AudioStream> {
      for await (const chunk of audio) {
        if (chunk.length > 0) yield { AudioEvent: { AudioChunk: chunk } };
      }
    }

    const response = await this.client.send(
      new StartStreamTranscriptionCommand({
        LanguageCode: this.languageCode as LanguageCode,
        MediaEncoding: 'pcm',
        MediaSampleRateHertz: format.sampleRate,
        AudioStream: audioEvents(),
      }),
      { abortSignal: signal },
    );

    const finals: string[] = [];
    let reported = '';
    for await (const event of response.TranscriptResultStream ?? []) {
      if (event.TranscriptEvent) {
        // The sentence still being spoken arrives as partial results, replaced by a final one.
        let partial = '';
        for (const result of event.TranscriptEvent.Transcript?.Results ?? []) {
          const text = result.Alternatives?.[0]?.Transcript?.trim();
          if (!text) continue;
          if (result.IsPartial) partial = text;
          else finals.push(text);
        }
        const soFar = [...finals, partial].join(' ').trim();
        if (soFar.length > 0 && soFar !== reported) {
          reported = soFar;
          hooks?.onPartial?.(soFar);
        }
        continue;
      }
      const failure =
        event.BadRequestException ??
        event.LimitExceededException ??
        event.InternalFailureException ??
        event.ConflictException ??
        event.ServiceUnavailableException;
      if (failure) throw new Error(`Transcribe stream error: ${failure.Message ?? 'unknown error'}`);
    }
    return finals.join(' ').trim();
  }
}
