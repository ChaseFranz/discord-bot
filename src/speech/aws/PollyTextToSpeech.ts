import { PassThrough, Readable } from 'node:stream';
import {
  DescribeVoicesCommand,
  PollyClient,
  StartSpeechSynthesisStreamCommand,
  SynthesizeSpeechCommand,
  type Engine,
  type StartSpeechSynthesisStreamActionStream,
  type VoiceId,
} from '@aws-sdk/client-polly';
import type { Logger } from '../../logging/logger.js';
import { describeError } from '../../logging/logger.js';
import type { SpeechStream, SynthesizedSpeech, TextToSpeech } from '../ports.js';

export interface PollyOptions {
  region: string;
  voiceId: string;
  engine: string;
  /** Offer streams (StartSpeechSynthesisStream) for replies. Only the generative engine has them. */
  streaming?: boolean;
  client?: PollyClient;
  logger?: Logger;
  /** How long a stream may go without hearing from us before a keep-alive is sent (Polly closes it after 5 s). */
  keepAliveMs?: number;
}

/** Polly accepts up to 3,000 billed characters of plain text per request. */
const MAX_POLLY_CHARACTERS = 3_000;
const KEEP_ALIVE_MS = 4_000;

/**
 * Text-to-speech with Amazon Polly. The audio is asked for as Opus at 48 kHz, which Discord plays
 * without any conversion, and is handed over while Polly is still producing it: for a sentence of
 * four seconds that is about a third of a second after asking, not most of a second.
 *
 * With `streaming`, a reply can also be spoken through one two-way stream (openStream): its
 * sentences go in as they are written and come out as one flowing run of speech.
 */
export class PollyTextToSpeech implements TextToSpeech {
  private readonly client: PollyClient;
  /** Set once Polly has said this identity may not stream: from then on replies are spoken a sentence at a time. */
  private streamingRefused = false;

  constructor(private readonly options: PollyOptions) {
    this.client = options.client ?? new PollyClient({ region: options.region });
  }

  /**
   * Confirms the credentials/region work and that the voice supports the engine (DescribeVoices is free).
   * Returns a problem description, or undefined when everything checks out.
   */
  async verify(): Promise<string | undefined> {
    const response = await this.client.send(new DescribeVoicesCommand({ Engine: this.options.engine as Engine }));
    const voice = response.Voices?.find((candidate) => candidate.Id === this.options.voiceId);
    if (!voice) {
      return `Polly voice "${this.options.voiceId}" doesn't support the "${this.options.engine}" engine in ${this.options.region}. Check POLLY_VOICE_ID / POLLY_ENGINE.`;
    }
    return undefined;
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<SynthesizedSpeech> {
    const response = await this.client.send(
      new SynthesizeSpeechCommand({
        Text: text.slice(0, MAX_POLLY_CHARACTERS),
        TextType: 'text',
        OutputFormat: 'ogg_opus',
        SampleRate: '48000',
        VoiceId: this.options.voiceId as VoiceId,
        Engine: this.options.engine as Engine,
      }),
      { abortSignal: signal },
    );
    const stream = response.AudioStream;
    if (!stream) throw new Error('Polly returned no audio');
    // In Node the body is a stream that is still arriving. (Anywhere it isn't, take it whole.)
    const audio = stream instanceof Readable ? stream : Readable.from([Buffer.from(await stream.transformToByteArray())]);
    return { audio, format: 'ogg_opus' };
  }

  openStream(): SpeechStream | undefined {
    if (!this.options.streaming || this.options.engine !== 'generative' || this.streamingRefused) return undefined;
    const events = new EventQueue<StartSpeechSynthesisStreamActionStream>();
    const audio = new PassThrough();
    // Nobody may be reading it when it fails (a reply cut off a moment earlier): that is not a crash.
    audio.on('error', () => undefined);
    const aborter = new AbortController();
    let open = true;
    let keepAlive: NodeJS.Timeout | undefined;
    const quiet = () => {
      open = false;
      clearTimeout(keepAlive);
      events.close();
    };
    const touch = () => {
      clearTimeout(keepAlive);
      if (!open) return;
      // While nothing is being written (it is looking something up, say), Polly is kept listening.
      keepAlive = setTimeout(() => {
        events.push({ TextEvent: { Text: ' ' } });
        touch();
      }, this.options.keepAliveMs ?? KEEP_ALIVE_MS);
      keepAlive.unref?.();
    };
    touch();

    void (async () => {
      const response = await this.client.send(
        new StartSpeechSynthesisStreamCommand({
          Engine: 'generative',
          VoiceId: this.options.voiceId as VoiceId,
          OutputFormat: 'ogg_opus',
          SampleRate: '48000',
          ActionStream: events,
        }),
        { abortSignal: aborter.signal },
      );
      for await (const event of response.EventStream ?? []) {
        if (event.AudioEvent?.AudioChunk) {
          audio.write(Buffer.from(event.AudioEvent.AudioChunk));
          continue;
        }
        const problem = event.ValidationException ?? event.ServiceQuotaExceededException ?? event.ThrottlingException ?? event.ServiceFailureException;
        if (problem) throw new Error(problem.message ?? 'Polly ended the stream with an error');
      }
      audio.end();
    })().catch((error: unknown) => {
      quiet();
      if (aborter.signal.aborted) {
        audio.destroy();
        return;
      }
      if ((error as { name?: string } | undefined)?.name === 'AccessDeniedException' && !this.streamingRefused) {
        this.streamingRefused = true;
        this.options.logger?.warn(
          `Polly won't stream speech for this identity, so replies are spoken a sentence at a time (it needs polly:StartSpeechSynthesisStream): ${describeError(error)}`,
        );
      }
      audio.destroy(error instanceof Error ? error : new Error(String(error)));
    });

    return {
      write: (text, flush = false) => {
        if (!open) return;
        events.push({ TextEvent: { Text: text, TextType: 'text', ...(flush ? { FlushStreamConfiguration: { Force: true } } : {}) } });
        touch();
      },
      end: () => {
        if (!open) return;
        events.push({ CloseStreamEvent: {} });
        quiet();
      },
      abort: () => {
        quiet();
        aborter.abort();
        audio.destroy();
      },
      audio,
    };
  }
}

/** Events handed to the SDK as it asks for them: an async iterable that is fed from outside. */
class EventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | undefined;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiting = this.waiting;
    this.waiting = undefined;
    if (waiting) waiting({ value: item, done: false });
    else this.items.push(item);
  }

  /** No more events: whatever was pushed is still handed over, then it ends. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}
