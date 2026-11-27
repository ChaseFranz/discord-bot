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
});
