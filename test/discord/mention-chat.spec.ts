import type { Message } from 'discord.js';
import type { AssistantReply, AssistantRequest } from '../../src/assistant/Assistant.js';
import { MentionChat } from '../../src/discord/MentionChat.js';
import type { AppServices } from '../../src/discord/types.js';
import { silentLogger } from '../helpers.js';

const BOT = '111';

interface Sent {
  kind: 'reply' | 'send';
  content: string;
  allowedMentions: unknown;
}

describe('MentionChat', () => {
  let requests: AssistantRequest[];
  let sent: Sent[];
  let paused: boolean;
  let reply: AssistantReply;
  let chat: MentionChat;
  let fetched: string[];

  const services = () =>
    ({
      config: { assistant: { name: 'Nimbus' } },
      logger: silentLogger(),
      assistant: {
        respond: async (request: AssistantRequest) => {
          requests.push(request);
          return reply;
        },
      },
      usage: {
        isPaused: () => paused,
        status: () => ({ day: '2026-11-26', spentUsd: paused ? 5 : 1, budgetUsd: 5, state: paused ? 'paused' : 'ok', resetsAt: 1_795_700_000_000 }),
      },
      calls: { voiceChannelOf: async () => undefined, musicStatus: async () => 'nothing playing' },
    }) as unknown as AppServices;

  function message(content: string, overrides: Record<string, unknown> = {}): Message {
    const channel = {
      name: 'general',
      sendTyping: async () => undefined,
      send: async (options: { content: string; allowedMentions: unknown }) => {
        sent.push({ kind: 'send', content: options.content, allowedMentions: options.allowedMentions });
      },
    };
    const names: Record<string, string> = { [BOT]: 'Nimbus', '222': 'Sam' };
    const mentioned = content.match(/<@!?(\d+)>/g)?.map((m) => m.replace(/\D/g, '')) ?? [];
    const users = new Map(mentioned.map((id) => [id, { displayName: names[id] ?? id }]));
    return {
      inGuild: () => true,
      guildId: 'g',
      author: { id: 'alice', bot: false, tag: 'alice#0001', displayName: 'Alice' },
      system: false,
      webhookId: null,
      content,
      channelId: 'chan-1',
      channel,
      member: { displayName: 'Alice', voice: { channel: null } },
      guild: {
        members: { me: { roles: { botRole: { id: 'role-bot' } } } },
        roles: { cache: new Map() },
        channels: { cache: new Map() },
      },
      mentions: {
        roles: new Map(),
        users,
        members: new Map(),
      },
      reference: null,
      attachments: new Map(),
      reply: async (options: { content: string; allowedMentions: unknown }) => {
        sent.push({ kind: 'reply', content: options.content, allowedMentions: options.allowedMentions });
      },
      ...overrides,
    } as unknown as Message;
  }

  beforeEach(() => {
    requests = [];
    sent = [];
    fetched = [];
    paused = false;
    reply = { text: 'Hello Alice!', silent: false, outcome: 'answered', sources: [], model: 'claude-opus-5-5' };
    chat = new MentionChat(services(), {
      guildId: 'g',
      botUserId: () => BOT,
      fetch: (async (url: string) => {
        fetched.push(url);
        return new Response(new Uint8Array([1, 2, 3]));
      }) as unknown as typeof fetch,
    });
  });

  it('answers a mention as a reply, with mentions resolved and nobody else pinged', async () => {
    await chat.handle(message(`<@${BOT}> say hi to <@222>`));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      scope: { guildId: 'g', userId: 'alice' }, userDisplayName: 'Alice', text: 'say hi to @Sam (user 222)',
      textChannelId: 'chan-1', channelName: 'general', images: [],
    });
    expect(sent).toEqual([{ kind: 'reply', content: 'Hello Alice!', allowedMentions: { parse: [], repliedUser: true } }]);
  });

  it('ignores messages that do not mention it, from bots, or from other servers', async () => {
    await chat.handle(message('just chatting'));
    // A reply to one of its messages with the ping turned off: Discord hides the text, so leave it.
    await chat.handle(message('', { reference: { messageId: 'm1' }, mentions: { repliedUser: { id: BOT }, roles: new Map(), users: new Map(), members: new Map() } }));
    await chat.handle(message(`<@${BOT}> hi`, { author: { id: 'b', bot: true, tag: 'b' } }));
    await chat.handle(message(`<@${BOT}> hi`, { guildId: 'elsewhere' }));
    expect(requests).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("answers when its role is mentioned instead, and greets an empty mention", async () => {
    await chat.handle(message('<@&role-bot> what time is it', { mentions: { roles: new Map([['role-bot', { name: 'Nimbus' }]]), users: new Map(), members: new Map() } }));
    expect(requests).toHaveLength(1);
    await chat.handle(message(`<@${BOT}>`));
    expect(requests).toHaveLength(1);
    expect(sent.at(-1)?.content).toContain('Ask me anything');
  });

  it('shows images to Claude and notes files it cannot open', async () => {
    const attachments = new Map([
      ['1', { name: 'cat.png', contentType: 'image/png', size: 3, width: 10, height: 10, url: 'https://cdn.example/cat.png' }],
      ['2', { name: 'notes.pdf', contentType: 'application/pdf', size: 3, url: 'https://cdn.example/notes.pdf' }],
      ['3', { name: 'huge.jpg', contentType: 'image/jpeg', size: 9_000_000, width: 10, height: 10, url: 'https://cdn.example/huge.jpg' }],
    ]);
    await chat.handle(message(`<@${BOT}> what is this?`, { attachments }));
    expect(fetched).toEqual(['https://cdn.example/cat.png']);
    expect(requests[0]!.images).toEqual([{ name: 'cat.png', mediaType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') }]);
    expect(requests[0]!.text).toBe(
      "what is this?\n(Attached notes.pdf, which you can't open.)\n(Attached image huge.jpg, too large for you to view.)",
    );
  });

  it('quotes the message being replied to when it can be read', async () => {
    const reference = { messageId: 'm0' };
    const fetchReference = async () => ({ content: 'Pizza or tacos tonight?', author: { id: 'sam', displayName: 'Sam' }, member: { displayName: 'Sam' } });
    await chat.handle(message(`<@${BOT}> which one?`, { reference, fetchReference }));
    expect(requests[0]!.text).toBe('(Replying to Sam: "Pizza or tacos tonight?")\nwhich one?');
  });

  it("says it's paused instead of answering once the budget is spent", async () => {
    paused = true;
    await chat.handle(message(`<@${BOT}> hello?`));
    expect(requests).toHaveLength(0);
    expect(sent[0]!.content).toContain("today's spending limit ($5.00)");
  });

  it('splits long replies and adds sources', async () => {
    reply = { ...reply, text: `${'word '.repeat(500)}`.trim(), sources: [{ title: 'Example', url: 'https://example.com' }] };
    await chat.handle(message(`<@${BOT}> write a lot`));
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0]!.kind).toBe('reply');
    expect(sent.slice(1).every((s) => s.kind === 'send' && JSON.stringify(s.allowedMentions) === '{"parse":[]}')).toBe(true);
    expect(sent.every((s) => s.content.length <= 2_000)).toBe(true);
    expect(sent.at(-1)!.content).toContain('[Example](https://example.com)');
  });
});
