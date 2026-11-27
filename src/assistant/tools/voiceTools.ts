import { z } from 'zod';
import { NativeToolProvider, defineTool } from './nativeTool.js';

/** What stop_speaking needs from the voice layer. */
export interface SpeechControl {
  get(guildId: string): { stopSpeaking(): boolean } | undefined;
}

/** The two ways the assistant chooses silence in a call: there's nothing to say, or it was told to stop. */
export function createVoiceToolProvider(voice: SpeechControl): NativeToolProvider {
  return new NativeToolProvider('voice', [
    defineTool({
      name: 'say_nothing',
      description:
        "Stay silent this turn. Call it in a voice call when the new lines don't need a reply from you: they were " +
        'for someone else, you can\'t tell whether they were for you, or they change nothing about what you were ' +
        'saying. If you had been interrupted, you carry on from where you stopped. Do not write a reply after calling it.',
      input: z.object({}),
      run: async (_input, context) => {
        context.signals.silenceRequested = true;
        return 'Staying quiet.';
      },
    }),
    defineTool({
      name: 'stop_speaking',
      description:
        'Stop talking immediately and stay quiet for this turn. Call it when someone tells you to stop, be ' +
        'quiet, shut up, or never mind. Do not write a reply after calling it.',
      input: z.object({}),
      run: async (_input, context) => {
        context.signals.silenceRequested = true;
        context.signals.stopRequested = true;
        const wasSpeaking = voice.get(context.guildId)?.stopSpeaking() ?? false;
        return wasSpeaking ? 'Stopped speaking.' : 'You were not speaking. Staying quiet.';
      },
    }),
  ]);
}
