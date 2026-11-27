import { generateKeyPairSync, sign } from 'node:crypto';
import { ApplicationCommandType, ComponentType, InteractionType, type APIInteraction } from 'discord-api-types/v10';
import { SlashCommandBuilder } from 'discord.js';
import { createEdgeHandler } from '../../src/aws/edge.js';
import { loadAwsSettings, loadSecrets } from '../../src/aws/settings.js';
import { InteractionWorker } from '../../src/aws/worker.js';
import { CommandDispatcher } from '../../src/discord/CommandDispatcher.js';
import type { DiscordRestApi } from '../../src/discord/http.js';
import { createSignatureVerifier } from '../../src/discord/httpEdge.js';
import type { AppServices, BotCommand, ComponentHandler } from '../../src/discord/types.js';
import { silentLogger } from '../helpers.js';

describe('the edge (Discord interactions endpoint)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const verify = createSignatureVerifier(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'));
  const signed = (body: string, timestamp = String(Math.floor(Date.now() / 1000))) => ({
    headers: { 'X-Signature-Ed25519': sign(null, Buffer.from(timestamp + body), privateKey).toString('hex'), 'x-signature-timestamp': timestamp },
    body,
  });

  it('answers PING, defers commands and hands them on, and refuses bad signatures', async () => {
    const handedOff: string[] = [];
    const edge = createEdgeHandler({ verify, handOff: async (body) => void handedOff.push(body) });

    expect(await edge(signed('{"type":1}'))).toMatchObject({ statusCode: 200, body: '{"type":1}' });
    const command = JSON.stringify({ type: InteractionType.ApplicationCommand, data: { name: 'usage' } });
    expect(await edge(signed(command))).toMatchObject({ statusCode: 200, body: '{"type":5,"data":{"flags":64}}' });
    expect(handedOff).toEqual([command]);

    expect((await edge({ ...signed(command), body: command.replace('usage', 'chat') })).statusCode).toBe(401);
    expect((await edge({ body: command })).statusCode).toBe(401);
    const base64 = signed(command);
    expect((await edge({ ...base64, body: Buffer.from(base64.body).toString('base64'), isBase64Encoded: true })).statusCode).toBe(200);
    expect((await edge(signed('{"type":5}'))).statusCode).toBe(400);
    expect((await edge(signed('not json'))).statusCode).toBe(400);
  });
});

describe('the worker', () => {
  const member = { user: { id: 'u1', username: 'alice', discriminator: '0' } };
  const commandInteraction = (name: string, guildId = 'g') =>
    ({
      type: InteractionType.ApplicationCommand, id: `i-${name}`, application_id: 'app', token: 'tok', guild_id: guildId,
      channel: { id: 'c1', name: 'general', type: 0 }, member,
      data: { id: 'cmd', name, type: ApplicationCommandType.ChatInput },
    }) as unknown as APIInteraction;

  function setup() {
    const replies: unknown[] = [];
    const rest: DiscordRestApi = {
      get: async () => undefined,
      post: async (_route, body) => void replies.push(body),
      patch: async (_route, body) => void replies.push(body),
    };
    const events: string[] = [];
    const command = (name: string, voice?: BotCommand['voice']): BotCommand => ({
      data: new SlashCommandBuilder().setName(name).setDescription(name),
      usage: `/${name}`,
      voice,
      execute: async (context) => {
        events.push(`ran ${name}`);
        await context.editReply(`did ${name}`);
      },
    });
    const components: ComponentHandler[] = [{ prefix: 'reset', execute: async (context) => void events.push(`clicked ${context.customId}`) }];
    const dispatcher = new CommandDispatcher(
      [command('usage'), command('join', 'starts-call')],
      components,
      { logger: silentLogger() } as unknown as AppServices,
    );
    const worker = new InteractionWorker({
      guildId: 'g',
      applicationId: 'app',
      rest,
      dispatcher,
      control: { dispatch: async (cmd) => void events.push(`relayed ${cmd.data.name}`) },
      usage: { refresh: async () => void events.push('refresh'), flush: async () => void events.push('flush') },
      logger: silentLogger(),
    });
    return { worker, replies, events };
  }

  it('runs text commands, relays voice commands, and saves spending before returning', async () => {
    const { worker, replies, events } = setup();
    await worker.handle(commandInteraction('usage'));
    await worker.handle(commandInteraction('join'));
    expect(events).toEqual(['refresh', 'ran usage', 'flush', 'refresh', 'relayed join', 'flush']);
    expect(replies).toEqual([{ content: 'did usage', allowed_mentions: { parse: [] } }]);
  });

  it('says music is turned off without starting the voice task', async () => {
    const replies: unknown[] = [];
    const events: string[] = [];
    const play: BotCommand = {
      data: new SlashCommandBuilder().setName('play').setDescription('play'),
      usage: '/play',
      voice: 'starts-call',
      feature: 'music',
      execute: async () => void events.push('ran play'),
    };
    const worker = new InteractionWorker({
      guildId: 'g',
      applicationId: 'app',
      rest: { get: async () => undefined, post: async (_route, body) => void replies.push(body), patch: async (_route, body) => void replies.push(body) },
      dispatcher: new CommandDispatcher([play], [], { logger: silentLogger(), config: { music: { enabled: false } } } as unknown as AppServices),
      control: { dispatch: async (cmd) => void events.push(`relayed ${cmd.data.name}`) },
      usage: { refresh: async () => void events.push('refresh'), flush: async () => void events.push('flush') },
      logger: silentLogger(),
    });
    await worker.handle(commandInteraction('play'));
    expect(events).toEqual(['flush']);
    expect(replies).toEqual([{ content: 'Music is turned off for now.', allowed_mentions: { parse: [] } }]);
  });

  it('says nobody is running a music helper without starting the voice task, and relays /play when someone is', async () => {
    const replies: unknown[] = [];
    const events: string[] = [];
    const play: BotCommand = {
      data: new SlashCommandBuilder().setName('play').setDescription('play'),
      usage: '/play',
      voice: 'starts-call',
      feature: 'music',
      cooldownSeconds: 0,
      execute: async () => void events.push('ran play'),
    };
    let blocker: () => Promise<string | undefined> = async () => 'Music needs a helper right now, and nobody\'s is running.';
    const worker = new InteractionWorker({
      guildId: 'g',
      applicationId: 'app',
      rest: { get: async () => undefined, post: async (_route, body) => void replies.push(body), patch: async (_route, body) => void replies.push(body) },
      dispatcher: new CommandDispatcher([play], [], {
        logger: silentLogger(),
        config: { music: { enabled: true } },
        musicHelpers: { blocker: () => blocker() },
      } as unknown as AppServices),
      control: { dispatch: async (cmd) => void events.push(`relayed ${cmd.data.name}`) },
      usage: { refresh: async () => void events.push('refresh'), flush: async () => void events.push('flush') },
      logger: silentLogger(),
    });
    await worker.handle(commandInteraction('play'));
    expect(events).toEqual(['flush']);
    expect(replies).toEqual([{ content: "Music needs a helper right now, and nobody's is running.", allowed_mentions: { parse: [] } }]);

    blocker = async () => undefined;
    await worker.handle(commandInteraction('play'));
    // If helpers can't be checked, /play goes ahead: the voice task says what went wrong itself.
    blocker = async () => Promise.reject(new Error('database is down'));
    await worker.handle(commandInteraction('play'));
    expect(events).toEqual(['flush', 'refresh', 'relayed play', 'flush', 'refresh', 'relayed play', 'flush']);
    expect(replies).toHaveLength(1);
  });

  it('refuses other servers and unknown commands, and routes buttons', async () => {
    const { worker, replies, events } = setup();
    await worker.handle(commandInteraction('usage', 'elsewhere'));
    await worker.handle(commandInteraction('gone'));
    await worker.handle({
      type: InteractionType.MessageComponent, id: 'i2', application_id: 'app', token: 'tok2', guild_id: 'g', member,
      data: { custom_id: 'reset:confirm', component_type: ComponentType.Button },
    } as unknown as APIInteraction);
    expect(replies).toEqual([
      { content: 'This bot only works in its own server.', allowed_mentions: { parse: [] } },
      { content: 'That command no longer exists.', allowed_mentions: { parse: [] } },
    ]);
    expect(events).toEqual(['flush', 'flush', 'refresh', 'clicked reset:confirm', 'flush']);
  });
});

describe('AWS settings', () => {
  it('reads just the settings asked for, reporting every problem at once', () => {
    const env = {
      VOICE_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123/nimbus-voice.fifo',
      VOICE_TASK_SUBNETS: 'subnet-a, subnet-b',
    };
    expect(loadAwsSettings(['VOICE_QUEUE_URL', 'VOICE_TASK_SUBNETS', 'VOICE_TASK_IDLE_EXIT_SECONDS'], env)).toEqual({
      VOICE_QUEUE_URL: env.VOICE_QUEUE_URL,
      VOICE_TASK_SUBNETS: ['subnet-a', 'subnet-b'],
      VOICE_TASK_IDLE_EXIT_SECONDS: 120,
    });
    expect(() => loadAwsSettings(['DISCORD_PUBLIC_KEY', 'WORKER_FUNCTION_NAME'], { DISCORD_PUBLIC_KEY: 'nope' })).toThrow(
      /DISCORD_PUBLIC_KEY: must be the 64-character hex public key[\s\S]*WORKER_FUNCTION_NAME/,
    );
  });

  it('loads secrets into the environment without overwriting what is set', async () => {
    const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN_SECRET: 'nimbus/discord-token', ANTHROPIC_API_KEY_SECRET: 'nimbus/key', ANTHROPIC_API_KEY: 'already' };
    const asked: string[] = [];
    await loadSecrets(env, {
      send: async (command: { input: { SecretId: string } }) => {
        asked.push(command.input.SecretId);
        return { SecretString: ' the-token \n' };
      },
    } as never);
    expect(env.DISCORD_BOT_TOKEN).toBe('the-token');
    expect(env.ANTHROPIC_API_KEY).toBe('already');
    expect(asked).toEqual(['nimbus/discord-token']);
    await expect(loadSecrets({ DISCORD_BOT_TOKEN_SECRET: 'empty' }, { send: async () => ({ SecretString: '' }) } as never)).rejects.toThrow('is empty');
  });
});
