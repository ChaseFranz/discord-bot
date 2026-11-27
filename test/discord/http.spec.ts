import { generateKeyPairSync, sign } from 'node:crypto';
import { ApplicationCommandOptionType, ApplicationCommandType, ComponentType, InteractionType, type APIInteraction } from 'discord.js';
import {
  RestCallInfo,
  RestMessenger,
  httpCommandContext,
  httpComponentContext,
  isChatInputGuildCommand,
  isGuildComponent,
  type DiscordRestApi,
} from '../../src/discord/http.js';
import { createSignatureVerifier, initialResponse } from '../../src/discord/httpEdge.js';

/** Records every REST call; `responses` answers GETs by route. */
function fakeRest(responses: Record<string, unknown | Error> = {}) {
  const calls: Array<{ method: string; route: string; body?: unknown; auth?: boolean }> = [];
  const rest: DiscordRestApi = {
    get: async (route) => {
      calls.push({ method: 'GET', route });
      const response = responses[route];
      if (response instanceof Error) throw response;
      return response;
    },
    post: async (route, body, options) => {
      calls.push({ method: 'POST', route, body, auth: options?.auth });
      return responses[`POST ${route}`];
    },
    patch: async (route, body, options) => {
      calls.push({ method: 'PATCH', route, body, auth: options?.auth });
      return undefined;
    },
  };
  return { rest, calls };
}

const member = { user: { id: 'u1', username: 'alice', discriminator: '0', global_name: 'Alice A' }, nick: 'Ali' };

const chatCommand = {
  type: InteractionType.ApplicationCommand,
  id: 'i1',
  application_id: 'app',
  token: 'tok',
  guild_id: 'g',
  channel: { id: 'c1', name: 'general', type: 0 },
  member,
  data: {
    id: 'cmd', name: 'chat', type: ApplicationCommandType.ChatInput,
    options: [{ name: 'prompt', type: ApplicationCommandOptionType.String, value: 'hello there' }],
  },
} as unknown as APIInteraction;

describe('HTTP interactions', () => {
  it('checks Discord request signatures', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    const now = 1_795_700_000_000;
    const verifier = createSignatureVerifier(raw, () => now);
    const timestamp = String(now / 1000);
    const body = '{"type":1}';
    const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');

    expect(verifier(signature, timestamp, body)).toBe(true);
    expect(verifier(signature, timestamp, '{"type":2}')).toBe(false);
    expect(verifier(signature, String(now / 1000 - 3_600), body)).toBe(false); // too old to trust
    expect(verifier('zz', timestamp, body)).toBe(false);
    expect(verifier(undefined, timestamp, body)).toBe(false);
    expect(() => createSignatureVerifier('not-a-key')).toThrow('DISCORD_PUBLIC_KEY');
  });

  it('answers right away: pong, thinking, or thinking only to you', () => {
    const ephemeral = new Set(['memories']);
    expect(initialResponse({ type: InteractionType.Ping } as APIInteraction, ephemeral)).toEqual({ type: 1 });
    expect(initialResponse(chatCommand, ephemeral)).toEqual({ type: 5, data: {} });
    const memories = { ...chatCommand, data: { ...(chatCommand as { data: object }).data, name: 'memories' } } as unknown as APIInteraction;
    expect(initialResponse(memories, ephemeral)).toEqual({ type: 5, data: { flags: 64 } });
    expect(initialResponse({ type: InteractionType.MessageComponent } as APIInteraction, ephemeral)).toEqual({ type: 6 });
    expect(initialResponse({ type: InteractionType.ModalSubmit } as APIInteraction, ephemeral)).toBeUndefined();
  });

  it('reads commands and replies through the interaction token, pinging nobody', async () => {
    expect(isChatInputGuildCommand(chatCommand)).toBe(true);
    expect(isChatInputGuildCommand({ ...chatCommand, guild_id: undefined, member: undefined } as unknown as APIInteraction)).toBe(false);
    const { rest, calls } = fakeRest();
    if (!isChatInputGuildCommand(chatCommand)) throw new Error('unreachable');
    const context = httpCommandContext(chatCommand, { rest, applicationId: 'app', ephemeral: true });
    expect(context).toMatchObject({ commandName: 'chat', guildId: 'g', userId: 'u1', userTag: 'alice', displayName: 'Ali', channelId: 'c1', channelName: 'general' });
    expect(context.string('prompt')).toBe('hello there');
    expect(context.string('missing')).toBeNull();

    await context.editReply('Done');
    await context.followUp({ content: 'More' });
    expect(calls).toEqual([
      { method: 'PATCH', route: '/webhooks/app/tok/messages/%40original', body: { content: 'Done', allowed_mentions: { parse: [] } }, auth: false },
      { method: 'POST', route: '/webhooks/app/tok', body: { content: 'More', allowed_mentions: { parse: [] }, flags: 64 }, auth: false },
    ]);
  });

  it('reads buttons and menus, and edits the message they are on', async () => {
    const menu = {
      type: InteractionType.MessageComponent, id: 'i2', application_id: 'app', token: 'tok2', guild_id: 'g', member,
      data: { custom_id: 'memories:forget', component_type: ComponentType.StringSelect, values: ['12'] },
    } as unknown as APIInteraction;
    expect(isGuildComponent(menu)).toBe(true);
    if (!isGuildComponent(menu)) throw new Error('unreachable');
    const { rest, calls } = fakeRest();
    const context = httpComponentContext(menu, { rest, applicationId: 'app' });
    expect(context).toMatchObject({ customId: 'memories:forget', kind: 'select', values: ['12'], userId: 'u1' });
    await context.update({ content: 'Forgot it', components: [] });
    await context.notify('Something went wrong.');
    expect(calls.map((call) => `${call.method} ${call.route}`)).toEqual(['PATCH /webhooks/app/tok2/messages/%40original', 'POST /webhooks/app/tok2']);
    expect(calls[1]!.body).toMatchObject({ flags: 64 });
  });

  it("finds a person's voice channel without a live connection", async () => {
    const notInVoice = Object.assign(new Error('Unknown Voice State'), { status: 404 });
    const { rest } = fakeRest({
      '/guilds/g/voice-states/u1': { channel_id: 'vc1' },
      '/guilds/g/voice-states/u2': notInVoice,
      '/guilds/g/voice-states/u3': { channel_id: 'vc2' },
      '/channels/vc2': { name: 'Gaming' },
    });
    const presence = {
      get: async () => ({ channelId: 'vc1', channelName: 'General', people: [{ id: 'u1', name: 'Alice' }], music: 'playing "Song"' }),
    };
    const calls = new RestCallInfo(rest, presence);
    expect(await calls.voiceChannelOf('g', 'u1')).toEqual({ id: 'vc1', name: 'General', people: [{ id: 'u1', name: 'Alice' }] });
    expect(await calls.voiceChannelOf('g', 'u2')).toBeUndefined();
    expect(await calls.voiceChannelOf('g', 'u3')).toEqual({ id: 'vc2', name: 'Gaming', people: [] });
    expect(await calls.musicStatus('g')).toBe('playing "Song"');
    expect(await new RestCallInfo(rest, { get: async () => undefined }).musicStatus('g')).toBe('nothing playing');
  });

  it('posts reminders by REST, in the right server only, or by DM', async () => {
    const { rest, calls } = fakeRest({ '/channels/c1': { guild_id: 'g' }, '/channels/c9': { guild_id: 'other' }, 'POST /users/@me/channels': { id: 'dm1' } });
    const messenger = new RestMessenger(rest);
    await messenger.postInChannel('g', 'c1', '⏰ <@u1> Reminder: stretch', 'u1');
    await expect(messenger.postInChannel('g', 'c9', 'x', 'u1')).rejects.toThrow('not found in this server');
    await messenger.sendDirect('u1', 'hello');
    // These use the default, the bot's token (unlike interaction replies, which use the interaction token).
    expect(calls.filter((call) => call.method === 'POST').map(({ auth: _auth, ...call }) => call)).toEqual([
      { method: 'POST', route: '/channels/c1/messages', body: { content: '⏰ <@u1> Reminder: stretch', allowed_mentions: { users: ['u1'] } } },
      { method: 'POST', route: '/users/@me/channels', body: { recipient_id: 'u1' } },
      { method: 'POST', route: '/channels/dm1/messages', body: { content: 'hello', allowed_mentions: { parse: [] } } },
    ]);
    expect(calls.every((call) => call.auth === undefined)).toBe(true);
  });

  it('retries a reply that races ahead of the "thinking…" response', async () => {
    let failures = 2;
    const calls: string[] = [];
    const rest: DiscordRestApi = {
      get: async () => undefined,
      post: async () => undefined,
      patch: async (route) => {
        calls.push(route);
        if (failures-- > 0) throw Object.assign(new Error('Unknown Webhook'), { status: 404 });
        return undefined;
      },
    };
    if (!isChatInputGuildCommand(chatCommand)) throw new Error('unreachable');
    await httpCommandContext(chatCommand, { rest, applicationId: 'app', ephemeral: false }).editReply('Done');
    expect(calls).toHaveLength(3);
    const broken: DiscordRestApi = { ...rest, patch: async () => { throw Object.assign(new Error('Missing Access'), { status: 403 }); } };
    await expect(httpCommandContext(chatCommand, { rest: broken, applicationId: 'app', ephemeral: false }).editReply('x')).rejects.toThrow('Missing Access');
  });
});
