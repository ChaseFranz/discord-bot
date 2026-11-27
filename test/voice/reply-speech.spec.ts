import { openReplySpeech, type ReplyVoice } from '../../src/voice/ReplySpeech.js';
import { SpeechQueue, type AudioSink } from '../../src/voice/SpeechQueue.js';
import { silentLogger } from '../helpers.js';

/** Audio here is just text, and each clip finishes as soon as it starts. */
class InstantSink implements AudioSink<string> {
  readonly played: string[] = [];
  async play(audio: string): Promise<void> {
    this.played.push(audio);
  }
  stop(): void {}
  discard(): void {}
  pause(): void {}
  resume(): void {}
}

describe('openReplySpeech', () => {
  const setup = () => {
    const sink = new InstantSink();
    const queue = new SpeechQueue<string>(sink, { started: () => undefined, idle: () => undefined }, silentLogger());
    const told: string[] = [];
    const voice: ReplyVoice<string> = {
      piece: (text) => {
        told.push(`written: ${text}`);
        return async () => `audio of ${text}`;
      },
      end: () => void told.push('end'),
      cancel: () => void told.push('cancel'),
    };
    return { sink, queue, told, voice };
  };

  it('hands each piece to the voice the moment it is written, and says when the reply is complete', async () => {
    const { sink, queue, told, voice } = setup();
    const speech = openReplySpeech(queue, voice);
    speech.say('One.');
    speech.say('Two.');
    speech.say('Three.');
    // All three went to the voice at once, though only the first two have been asked for audio yet.
    expect(told).toEqual(['written: One.', 'written: Two.', 'written: Three.']);
    speech.end();
    await speech.finished();
    expect(told.at(-1)).toBe('end');
    expect(sink.played).toEqual(['audio of One.', 'audio of Two.', 'audio of Three.']);
    expect(speech.progress()).toEqual({ heard: ['One.', 'Two.', 'Three.'], interrupted: undefined, unsaid: [] });
  });

  it('tells the voice when the reply is cancelled, and gives it nothing more after that', () => {
    const { queue, told, voice } = setup();
    const speech = openReplySpeech(queue, voice);
    speech.say('One.');
    speech.cancel();
    speech.say('Two.');
    expect(told).toEqual(['written: One.', 'cancel']);
  });

  it('still takes a plain function that makes each piece on its own', async () => {
    const { sink, queue } = setup();
    const speech = openReplySpeech(queue, async (text) => `made: ${text}`);
    speech.say('Hello.');
    speech.end();
    await speech.finished();
    expect(sink.played).toEqual(['made: Hello.']);
  });
});
