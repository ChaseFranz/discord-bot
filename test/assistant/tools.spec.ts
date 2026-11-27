import { Readable } from 'node:stream';
import { z } from 'zod';
import { createMusicToolProvider } from '../../src/assistant/tools/musicTools.js';
import { NativeToolProvider, defineTool, toInputSchema } from '../../src/assistant/tools/nativeTool.js';
import { ToolRegistry } from '../../src/assistant/tools/ToolRegistry.js';
import type { ToolContext } from '../../src/assistant/tools/types.js';
import { createVoiceToolProvider } from '../../src/assistant/tools/voiceTools.js';
import { MusicService } from '../../src/music/MusicService.js';
import type { MusicHost, MusicOutput } from '../../src/music/types.js';
import { silentLogger } from '../helpers.js';

const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  guildId: 'g',
  userId: 'u',
  userDisplayName: 'Alice',
  modality: 'voice',
  voiceChannelId: 'vc',
  textChannelId: 'vc',
  signals: { silenceRequested: false },
  ...overrides,
});

describe('native tools', () => {
  const echo = defineTool({
    name: 'echo',
    description: 'Echo.',
    input: z.object({ text: z.string().describe('What to echo'), times: z.number().int().optional() }),
    run: async ({ text, times }) => text.repeat(times ?? 1),
  });

  it('generates a JSON schema Claude accepts', () => {
    const schema = toInputSchema(echo.input);
    expect(schema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string', description: 'What to echo' }, times: { type: 'integer' } },
      required: ['text'],
    });
    expect(schema).not.toHaveProperty('$schema');
  });

  it('validates input before running (streamed inputs are not validated by the API)', async () => {
    const provider = new NativeToolProvider('t', [echo]);
    expect(await provider.callTool('echo', { text: 'hi', times: 2 }, context())).toEqual({ content: 'hihi' });
    const bad = await provider.callTool('echo', { text: 42 }, context());
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('text');
  });

  it('registry rejects duplicate names, sorts definitions, and turns throws into error results', async () => {
    const boom = defineTool({ name: 'boom', description: 'Boom.', input: z.object({}), run: async () => { throw new Error('kaput'); } });
    expect(() => new ToolRegistry([new NativeToolProvider('a', [echo]), new NativeToolProvider('b', [echo])])).toThrow('both');
    const registry = new ToolRegistry([new NativeToolProvider('a', [echo, boom])]);
    expect(registry.definitions().map((d) => d.name)).toEqual(['boom', 'echo']);
    expect(await registry.call('boom', {}, context())).toEqual({ content: 'Tool "boom" failed: kaput', isError: true });
    expect((await registry.call('nope', {}, context())).isError).toBe(true);
  });
});

describe('music and voice tools', () => {
  let state: 'idle' | 'playing' | 'paused' = 'idle';
  const output: MusicOutput = {
    get state() {
      return state;
    },
    play: () => {
      state = 'playing';
    },
    stop: () => {
      state = 'idle';
    },
    pause: () => (state === 'playing' ? ((state = 'paused'), true) : false),
    resume: () => (state === 'paused' ? ((state = 'playing'), true) : false),
    onIdle: () => () => undefined,
    onError: () => () => undefined,
  };
  const host: MusicHost = { ensureOutput: async () => output, queueFinished: () => undefined };
  const music = new MusicService(
    host,
    { resolve: async (q) => ({ title: q, url: `https://yt/${q}` }), open: async () => Readable.from(['x']) },
    silentLogger(),
  );
  const tools = createMusicToolProvider(music);

  it('plays for the person in voice and refuses when they are not in a channel', async () => {
    expect(await tools.callTool('play_music', { query: 'jazz' }, context())).toEqual({ content: 'Now playing "jazz" (https://yt/jazz).' });
    const notInVoice = await tools.callTool('play_music', { query: 'jazz' }, context({ voiceChannelId: undefined }));
    expect(notInVoice.isError).toBe(true);
  });

  it('returns expected failures as tool errors', async () => {
    expect(await tools.callTool('pause_music', {}, context())).toEqual({ content: 'Paused "jazz".' });
    expect(await tools.callTool('pause_music', {}, context())).toEqual({ content: 'The music is already paused.', isError: true });
    expect((await tools.callTool('get_music_queue', {}, context())).content).toContain('Paused: jazz');
  });

  it('stop_speaking flags the turn silent and stops speech', async () => {
    let stopped = false;
    const voice = createVoiceToolProvider({ get: () => ({ stopSpeaking: () => ((stopped = true), true) }) });
    const ctx = context();
    expect(await voice.callTool('stop_speaking', {}, ctx)).toEqual({ content: 'Stopped speaking.' });
    expect(ctx.signals.silenceRequested).toBe(true);
    expect(stopped).toBe(true);
  });
});
