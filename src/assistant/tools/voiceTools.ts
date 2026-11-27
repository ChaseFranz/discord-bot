import { z } from 'zod';
import { NativeToolProvider, defineTool } from './nativeTool.js';

/** What these tools need from the voice layer. */
export interface SpeechControl {
  get(guildId: string): { stopSpeaking(): boolean } | undefined;
  /** Leaves the guild's voice call. Returns false if it wasn't in one. */
  leave(guildId: string): Promise<boolean>;
}

/**
 * How the assistant controls its own presence in a call: staying silent when there's nothing to
 * say, stopping when it's told to, and leaving when it's told to go.
 */
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
    defineTool({
      name: 'leave_call',
      description:
        'Leave the voice call. Call it when someone tells you to leave, go away, get out, or that you can go ' +
        '("leave", "you can go now", "bye, we\'re done with you"). Not for a goodbye between other people, or ' +
        'someone saying that they themselves are leaving. In a call you leave once your reply has been said, ' +
        'so say goodbye in a few words, or write nothing.',
      input: z.object({}),
      run: async (_input, context) => {
        if (!voice.get(context.guildId)) return { content: 'You are not in a voice call.', isError: true };
        if (context.modality === 'voice') {
          // The call itself sees you out, after the goodbye (see VoiceConversationService).
          context.signals.leaveRequested = true;
          return 'You will leave the call as soon as your reply has been said.';
        }
        await voice.leave(context.guildId);
        return 'Left the voice call.';
      },
    }),
  ]);
}
