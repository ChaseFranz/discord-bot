import { z } from 'zod';
import type { MusicService } from '../../music/MusicService.js';
import { MusicError } from '../../music/types.js';
import { NativeToolProvider, defineTool, type NativeTool } from './nativeTool.js';
import type { ToolContext, ToolResult } from './types.js';

const NOT_IN_VOICE: ToolResult = {
  content: "The person you're talking to isn't in a voice channel, so there's no music to control for them.",
  isError: true,
};

/** Converts expected music failures ("nothing is playing") into error results the model can relay. */
function guard(run: (context: ToolContext) => Promise<string> | string) {
  return async (_input: unknown, context: ToolContext): Promise<ToolResult> => {
    try {
      return { content: await run(context) };
    } catch (error) {
      if (error instanceof MusicError) return { content: error.message, isError: true };
      throw error;
    }
  };
}

export function createMusicToolProvider(music: MusicService): NativeToolProvider {
  const tools: NativeTool[] = [
    defineTool({
      name: 'play_music',
      description:
        'Play a song from YouTube in the voice channel of the person you are talking to: it starts now if nothing ' +
        'is playing, otherwise it is added to the queue. Use it whenever they ask you to play or queue something.',
      input: z.object({
        query: z.string().min(1).describe('A YouTube URL, or search terms such as "artist - song title".'),
      }),
      run: async ({ query }, context) => {
        if (!context.voiceChannelId) return NOT_IN_VOICE;
        try {
          const { track, position } = await music.play(context.guildId, context.voiceChannelId, query, context.userDisplayName);
          return position === 0
            ? `Now playing "${track.title}" (${track.url}).`
            : `Added "${track.title}" to the queue at position ${position}.`;
        } catch (error) {
          if (error instanceof MusicError) return { content: error.message, isError: true };
          throw error;
        }
      },
    }),
    defineTool({
      name: 'skip_track',
      description: 'Skip the song that is playing and go to the next one in the queue.',
      input: z.object({}),
      run: guard((context) => `Skipped "${music.skip(context.guildId).title}".`),
    }),
    defineTool({
      name: 'pause_music',
      description: 'Pause the music.',
      input: z.object({}),
      run: guard((context) => `Paused "${music.pause(context.guildId).title}".`),
    }),
    defineTool({
      name: 'resume_music',
      description: 'Resume paused music.',
      input: z.object({}),
      run: guard((context) => `Resumed "${music.resume(context.guildId).title}".`),
    }),
    defineTool({
      name: 'stop_music',
      description: 'Stop the music and clear the whole queue. Use it when they want the music off, not just paused.',
      input: z.object({}),
      run: guard((context) => {
        const cleared = music.stop(context.guildId);
        return `Stopped the music and cleared ${cleared} track${cleared === 1 ? '' : 's'}.`;
      }),
    }),
    defineTool({
      name: 'get_music_queue',
      description: "List what's playing and what's queued up next.",
      input: z.object({}),
      run: guard((context) => {
        const { state, current, upcoming } = music.status(context.guildId);
        if (!current) return 'Nothing is playing and the queue is empty.';
        const next = upcoming.length > 0 ? `\nUp next:\n${upcoming.map((t, i) => `${i + 1}. ${t.title}`).join('\n')}` : '\nNothing else queued.';
        return `${state === 'paused' ? 'Paused' : 'Now playing'}: ${current.title}${next}`;
      }),
    }),
  ];
  return new NativeToolProvider('music', tools);
}
