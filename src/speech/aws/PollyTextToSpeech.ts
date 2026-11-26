import { Readable } from 'node:stream';
import { DescribeVoicesCommand, PollyClient, SynthesizeSpeechCommand, type Engine, type VoiceId } from '@aws-sdk/client-polly';
import type { SynthesizedSpeech, TextToSpeech } from '../ports.js';

export interface PollyOptions {
  region: string;
  voiceId: string;
  engine: string;
  client?: PollyClient;
}

/** Polly accepts up to 3,000 billed characters of plain text per request. */
const MAX_POLLY_CHARACTERS = 3_000;

/** Text-to-speech with Amazon Polly, returning MP3 that the voice player transcodes. */
export class PollyTextToSpeech implements TextToSpeech {
  private readonly client: PollyClient;

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
        OutputFormat: 'mp3',
        VoiceId: this.options.voiceId as VoiceId,
        Engine: this.options.engine as Engine,
      }),
      { abortSignal: signal },
    );
    if (!response.AudioStream) throw new Error('Polly returned no audio');
    const bytes = await response.AudioStream.transformToByteArray();
    return { audio: Readable.from([Buffer.from(bytes)]), format: 'mp3' };
  }
}
