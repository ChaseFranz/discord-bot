import { Readable } from 'node:stream';
import type { PollyClient } from '@aws-sdk/client-polly';
import { PollyTextToSpeech } from '../../src/speech/aws/PollyTextToSpeech.js';

describe('PollyTextToSpeech', () => {
  /** A Polly whose audio arrives in parts that the test sends by hand. */
  function setup() {
    const asked: Array<{ input: Record<string, unknown>; signal: AbortSignal | undefined }> = [];
    const body = new Readable({ read: () => undefined });
    const client = {
      send: async (command: { input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal }) => {
        asked.push({ input: command.input, signal: options?.abortSignal });
        if ('Text' in command.input) return { AudioStream: body };
        return { Voices: [{ Id: 'Joanna' }, { Id: 'Nate' }] };
      },
    } as unknown as PollyClient;
    const tts = new PollyTextToSpeech({ region: 'us-east-1', voiceId: 'Joanna', engine: 'generative', client });
    return { tts, asked, body };
  }

  it('asks for Opus as Discord plays it, and hands the audio over while it is still arriving', async () => {
    const { tts, asked, body } = setup();
    const cancel = new AbortController();
    const speech = await tts.synthesize('Sure, sixty-two degrees and cloudy.', cancel.signal);
    expect(asked[0]!.input).toEqual({
      Text: 'Sure, sixty-two degrees and cloudy.',
      TextType: 'text',
      OutputFormat: 'ogg_opus',
      SampleRate: '48000',
      VoiceId: 'Joanna',
      Engine: 'generative',
    });
    expect(asked[0]!.signal).toBe(cancel.signal);
    expect(speech.format).toBe('ogg_opus');

    // Nothing has arrived yet, and it is already in hand: the first part can be read before the last is sent.
    const parts: string[] = [];
    speech.audio.on('data', (chunk: Buffer) => parts.push(chunk.toString()));
    body.push('first ');
    await new Promise((resolve) => setImmediate(resolve));
    expect(parts).toEqual(['first ']);
    body.push('second');
    body.push(null);
    await new Promise((resolve) => speech.audio.once('end', resolve));
    expect(parts.join('')).toBe('first second');
  });

  it('sends no more than Polly takes in one request', async () => {
    const { tts, asked } = setup();
    await tts.synthesize('a'.repeat(5_000));
    expect(String(asked[0]!.input.Text)).toHaveLength(3_000);
  });

  it('says so when the voice does not come with the engine', async () => {
    const { tts } = setup();
    expect(await tts.verify()).toBeUndefined();
    const other = new PollyTextToSpeech({ region: 'us-east-1', voiceId: 'Gregory', engine: 'generative', client: (tts as unknown as { client: PollyClient }).client });
    expect(await other.verify()).toMatch(/"Gregory" doesn't support the "generative" engine/);
  });

  describe('speech streams', () => {
    /** A Polly that reads what is written to the stream and sends back audio the test hands it. */
    function streaming(options: { fails?: Error; keepAliveMs?: number; streaming?: boolean; engine?: string } = {}) {
      const events: unknown[] = [];
      const asked: Array<{ input: Record<string, unknown>; signal: AbortSignal | undefined }> = [];
      const audio: Array<(event: unknown) => void> = [];
      const pending: unknown[] = [];
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => (finish = resolve));
      const warnings: string[] = [];
      const client = {
        send: async (command: { input: Record<string, unknown> }, request?: { abortSignal?: AbortSignal }) => {
          asked.push({ input: command.input, signal: request?.abortSignal });
          void (async () => {
            for await (const event of command.input.ActionStream as AsyncIterable<unknown>) events.push(event);
          })();
          if (options.fails) throw options.fails;
          return {
            EventStream: (async function* () {
              for (;;) {
                const next = pending.shift() ?? (await Promise.race([new Promise((resolve) => audio.push(resolve)), finished.then(() => undefined)]));
                if (next === undefined) return;
                yield next;
              }
            })(),
          };
        },
      } as unknown as PollyClient;
      const tts = new PollyTextToSpeech({
        region: 'us-east-1',
        voiceId: 'Kenneth',
        engine: options.engine ?? 'generative',
        streaming: options.streaming ?? true,
        client,
        keepAliveMs: options.keepAliveMs ?? 10_000,
        logger: { warn: (message: string) => void warnings.push(message) } as never,
      });
      const sendAudio = (bytes: string) => {
        const event = { AudioEvent: { AudioChunk: new Uint8Array(Buffer.from(bytes)) } };
        const waiting = audio.shift();
        if (waiting) waiting(event);
        else pending.push(event);
      };
      return { tts, events, asked, sendAudio, finish, warnings };
    }
    const settle = async () => {
      for (let round = 0; round < 10; round++) await new Promise((resolve) => setImmediate(resolve));
    };
    const read = async (stream: Readable) => {
      let text = '';
      for await (const chunk of stream) text += String(chunk);
      return text;
    };

    it('sends the text as it is written and passes the audio on as it is made', async () => {
      const { tts, events, asked, sendAudio, finish } = streaming();
      const stream = tts.openStream()!;
      stream.write('Hello there.', true);
      stream.write(' How are you?');
      sendAudio('first ');
      sendAudio('second');
      stream.end();
      await settle();
      finish();
      expect(await read(stream.audio)).toBe('first second');
      expect(asked[0]!.input).toMatchObject({ Engine: 'generative', VoiceId: 'Kenneth', OutputFormat: 'ogg_opus', SampleRate: '48000' });
      expect(events).toEqual([
        { TextEvent: { Text: 'Hello there.', TextType: 'text', FlushStreamConfiguration: { Force: true } } },
        { TextEvent: { Text: ' How are you?', TextType: 'text' } },
        { CloseStreamEvent: {} },
      ]);
      // Nothing more goes in once it has ended.
      stream.write('too late');
      await settle();
      expect(events).toHaveLength(3);
    });

    it('keeps a stream open while nothing is being written, and stops once it has ended', async () => {
      const { tts, events } = streaming({ keepAliveMs: 20 });
      const stream = tts.openStream()!;
      stream.write('Let me look that up.', true);
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(events.filter((event) => JSON.stringify(event) === JSON.stringify({ TextEvent: { Text: ' ' } })).length).toBeGreaterThanOrEqual(2);
      stream.end();
      await settle();
      expect(events.at(-1)).toEqual({ CloseStreamEvent: {} });
      const count = events.length;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(events.length).toBe(count);
      stream.abort();
    });

    it('offers no stream when streaming is off or the engine has none, or once Polly has refused it', async () => {
      expect(streaming({ streaming: false }).tts.openStream()).toBeUndefined();
      expect(streaming({ engine: 'neural' }).tts.openStream()).toBeUndefined();

      const refused = Object.assign(new Error('User is not authorized to perform: polly:StartSpeechSynthesisStream'), { name: 'AccessDeniedException' });
      const { tts, warnings } = streaming({ fails: refused });
      const stream = tts.openStream()!;
      await expect(read(stream.audio)).rejects.toThrow('not authorized');
      // From then on, replies are spoken a sentence at a time, and that is said once.
      expect(tts.openStream()).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('polly:StartSpeechSynthesisStream');
    });

    it('fails its audio when the stream fails, and just ends it when aborted', async () => {
      const failing = streaming({ fails: new Error('throttled') }).tts.openStream()!;
      await expect(read(failing.audio)).rejects.toThrow('throttled');

      const { tts, asked } = streaming();
      const stream = tts.openStream()!;
      stream.write('Hello.', true);
      await settle();
      const ended = new Promise((resolve) => stream.audio.once('close', resolve));
      stream.abort();
      await ended;
      expect(asked[0]!.signal?.aborted).toBe(true);
      // Still offered: an abort is not a refusal.
      expect(tts.openStream()).toBeDefined();
    });
  });
});
