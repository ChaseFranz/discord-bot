import type { TranscribeStreamingClient } from '@aws-sdk/client-transcribe-streaming';
import { TranscribeSpeechToText } from '../../src/speech/aws/TranscribeSpeechToText.js';

/** One event from Transcribe: the results it holds, each final or still partial. */
const results = (...items: Array<[text: string, partial: boolean]>) => ({
  TranscriptEvent: { Transcript: { Results: items.map(([text, partial]) => ({ IsPartial: partial, Alternatives: [{ Transcript: text }] })) } },
});

function transcribing(events: unknown[]) {
  const sent: Array<{ input: Record<string, unknown> }> = [];
  const client = {
    send: async (command: { input: Record<string, unknown> }) => {
      sent.push(command);
      return {
        TranscriptResultStream: (async function* () {
          for (const event of events) yield event;
        })(),
      };
    },
  } as unknown as TranscribeStreamingClient;
  return { stt: new TranscribeSpeechToText({ region: 'us-east-1', languageCode: 'en-US', client }), sent };
}

async function* audio() {
  yield Buffer.alloc(3_200);
}
const PCM = { encoding: 'pcm_s16le', sampleRate: 48_000, channels: 1 } as const;

describe('TranscribeSpeechToText', () => {
  it('joins the final results into one transcript', async () => {
    const { stt, sent } = transcribing([
      results(['nimbus what', true]),
      results(['Nimbus, what time is it?', false]),
      results(['and', true]),
      results(['And tomorrow?', false]),
    ]);
    expect(await stt.transcribe(audio(), PCM)).toBe('Nimbus, what time is it? And tomorrow?');
    expect(sent[0]!.input).toMatchObject({ LanguageCode: 'en-US', MediaEncoding: 'pcm', MediaSampleRateHertz: 48_000 });
  });

  it('reports what has been said so far while they are still talking', async () => {
    const { stt } = transcribing([
      results(['nimbus', true]),
      results(['nimbus', true]), // unchanged: not reported twice
      results(['nimbus stop', true]),
      results(['Nimbus, stop.', false]),
      results(['the', true]),
      results(['The music.', false]),
      results(),
    ]);
    const partials: string[] = [];
    const text = await stt.transcribe(audio(), PCM, undefined, { onPartial: (partial) => partials.push(partial) });
    expect(partials).toEqual(['nimbus', 'nimbus stop', 'Nimbus, stop.', 'Nimbus, stop. the', 'Nimbus, stop. The music.']);
    expect(text).toBe('Nimbus, stop. The music.');
  });

  it('resolves to nothing when nothing intelligible was said', async () => {
    expect(await transcribing([results()]).stt.transcribe(audio(), PCM)).toBe('');
  });

  it('fails on a stream error, and refuses audio it cannot send', async () => {
    const { stt } = transcribing([results(['hello', true]), { LimitExceededException: { Message: 'too many streams' } }]);
    await expect(stt.transcribe(audio(), PCM)).rejects.toThrow('Transcribe stream error: too many streams');
    await expect(stt.transcribe(audio(), { ...PCM, channels: 2 } as never)).rejects.toThrow('mono 16-bit');
  });
});
