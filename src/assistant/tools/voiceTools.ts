import { z } from 'zod';
import { NativeToolProvider, defineTool } from './nativeTool.js';

/** What stop_speaking needs from the voice layer. */
export interface SpeechControl {
  get(guildId: string): { stopSpeaking(): boolean } | undefined;
}

export function createVoiceToolProvider(voice: SpeechControl): NativeToolProvider {
  return new NativeToolProvider('voice', [
    defineTool({
      name: 'stop_speaking',
      description:
        'Stop talking immediately and stay quiet for this turn. Call it when the person tells you to stop, be ' +
        'quiet, shut up, or never mind. Do not write a reply after calling it.',
      input: z.object({}),
      run: async (_input, context) => {
        context.signals.silenceRequested = true;
        const wasSpeaking = voice.get(context.guildId)?.stopSpeaking() ?? false;
        return wasSpeaking ? 'Stopped speaking.' : 'You were not speaking. Staying quiet.';
      },
    }),
  ]);
}
