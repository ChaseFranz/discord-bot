import { SlashCommandBuilder } from 'discord.js';
import { CommandDispatcher } from '../../src/discord/CommandDispatcher.js';
import { EPHEMERAL_COMMANDS } from '../../src/discord/commandMeta.js';
import { musicHelperCommand } from '../../src/discord/commands/musichelper.js';
import type { CommandContext, Reply } from '../../src/discord/context.js';
import type { AppServices, BotCommand } from '../../src/discord/types.js';
import { HelperDesk } from '../../src/music/relay/HelperDesk.js';
import { MemoryHelperRegistry } from '../../src/music/relay/memory.js';
import { parseSetupCode, parseToken, secretMatches } from '../../src/music/relay/tokens.js';
import { fakeClock, silentLogger } from '../helpers.js';

const GUILD = '1083158655429509190';
const ALICE = '100000000000000001';
const SAM = '100000000000000002';
const GUIDE = 'https://github.com/example/nimbus/tree/main/helper';

describe('/musichelper', () => {
  const clock = fakeClock(Date.UTC(2026, 10, 27, 20, 0, 0));
  let registry: MemoryHelperRegistry;
  let desk: HelperDesk;
  let replies: Reply[];

  beforeEach(() => {
    clock.set(Date.UTC(2026, 10, 27, 20, 0, 0));
    registry = new MemoryHelperRegistry();
    desk = new HelperDesk({ guildId: GUILD, registry, clock, apiUrl: 'https://helper.example/', guideUrl: GUIDE });
    replies = [];
  });

  const context = (userId: string, displayName: string, action?: string): CommandContext => ({
    commandName: 'musichelper', guildId: GUILD, userId, userTag: displayName.toLowerCase(), displayName, channelId: 'c', channelName: 'general',
    string: (name) => (name === 'action' ? (action ?? null) : null),
    editReply: async (reply) => void replies.push(reply),
    followUp: async (reply) => void replies.push(reply),
  });
  const services = (overrides: Partial<AppServices> = {}) =>
    ({ logger: silentLogger(), config: { music: { enabled: true } }, musicHelpers: desk, ...overrides }) as unknown as AppServices;
  const run = async (userId: string, displayName: string, action?: string, overrides?: Partial<AppServices>) => {
    await musicHelperCommand.execute(context(userId, displayName, action), services(overrides));
    return String(replies.at(-1));
  };
  /** The setup code shown in a reply, if there is one. */
  const codeIn = (reply: string) => /node nimbus-music-helper\.mjs (nimbus1\.[\w-]+)/.exec(reply)?.[1];

  it('is shown only to the person who used it', () => {
    expect(musicHelperCommand.ephemeral).toBe(true);
    expect(EPHEMERAL_COMMANDS.has('musichelper')).toBe(true);
  });

  it('gives a first-time user their code with the steps to set the helper up', async () => {
    const reply = await run(ALICE, 'Alice');
    expect(reply).toContain("**Running now:** nobody's.");
    expect(reply).toContain('**To set yours up** (once, about two minutes):');
    expect(reply).toContain('1. Install Node.js 22 or newer: <https://nodejs.org>');
    expect(reply).toContain(`2. Download \`nimbus-music-helper.mjs\` from <${GUIDE}>`);
    expect(reply).toContain("don't share it");

    const code = parseSetupCode(codeIn(reply)!)!;
    expect(code.apiUrl).toBe('https://helper.example/');
    const token = parseToken(code.token)!;
    expect(token).toMatchObject({ guildId: GUILD, userId: ALICE });
    expect(secretMatches(token.secret, (await registry.find(GUILD, ALICE))!.secretHash)).toBe(true);
  });

  it("doesn't show or replace a code again unless asked, and says who is running one", async () => {
    const first = codeIn(await run(ALICE, 'Alice'))!;
    await registry.checkIn(GUILD, ALICE, clock() + 2_000, '1.0.0');
    clock.advance(5_000);

    const status = await run(ALICE, 'Alice');
    expect(codeIn(status)).toBeUndefined();
    expect(status).toContain(`**Running now:** Alice (checked in <t:${Math.floor((clock() - 3_000) / 1000)}:R>)`);
    expect(status).toContain('**Yours:** set up');
    expect(status).toContain('Lost the code? `/musichelper action:New code` gives you a fresh one.');
    // The code they have still works.
    expect(secretMatches(parseToken(parseSetupCode(first)!.token)!.secret, (await registry.find(GUILD, ALICE))!.secretHash)).toBe(true);

    const fresh = await run(ALICE, 'Alice', 'new-code');
    expect(fresh).toContain('**Your new code** (the old one has stopped working):');
    expect(codeIn(fresh)).not.toBe(first);
    expect(secretMatches(parseToken(parseSetupCode(first)!.token)!.secret, (await registry.find(GUILD, ALICE))!.secretHash)).toBe(false);
  });

  it('removes a helper, so its code stops working', async () => {
    await run(ALICE, 'Alice');
    expect(await run(ALICE, 'Alice', 'remove')).toBe('Your music helper is removed: its code no longer works. `/musichelper` sets up a new one.');
    expect(await registry.find(GUILD, ALICE)).toBeUndefined();
    expect(await run(SAM, 'Sam', 'remove')).toBe("You don't have a music helper set up.");
  });

  it('says there is nothing to set up where the bot fetches music itself, or music is off', async () => {
    expect(await run(ALICE, 'Alice', undefined, { musicHelpers: undefined })).toBe(
      "This copy of Nimbus fetches music itself, so there's no helper to set up. Just use `/play`.",
    );
    expect(await run(ALICE, 'Alice', undefined, { musicHelpers: undefined, config: { music: { enabled: false } } as never })).toBe('Music is turned off for now.');
  });

  describe('starting music', () => {
    const command = (overrides: Partial<BotCommand>): BotCommand => ({
      data: new SlashCommandBuilder().setName('play').setDescription('play'),
      usage: '/play',
      execute: async (ctx) => ctx.editReply('playing'),
      ...overrides,
    });
    const play = command({ feature: 'music', voice: 'starts-call' });

    it('is refused, with how to get a helper, while nobody is running one', async () => {
      const dispatcher = new CommandDispatcher([play], [], services());
      expect(await dispatcher.blocked(play)).toMatch(/nobody's is running.*`\/musichelper`.*github\.com\/example/);
      await dispatcher.runCommand(play, context(ALICE, 'Alice'));
      expect(String(replies.at(-1))).toContain('Music needs a helper right now');

      await desk.issue(SAM, 'Sam');
      await registry.checkIn(GUILD, SAM, clock(), '1.0.0');
      expect(await dispatcher.blocked(play)).toBeUndefined();
      await dispatcher.runCommand(play, context(ALICE, 'Alice'));
      expect(replies.at(-1)).toBe('playing');
    });

    it('is not held up by helpers for anything else, or where the bot fetches music itself', async () => {
      const dispatcher = new CommandDispatcher([], [], services());
      // Skipping or pausing what is already playing needs no helper; nor does a command that isn't music.
      expect(await dispatcher.blocked(command({ feature: 'music', voice: 'in-call' }))).toBeUndefined();
      expect(await dispatcher.blocked(command({ voice: 'starts-call' }))).toBeUndefined();
      expect(await new CommandDispatcher([], [], services({ musicHelpers: undefined })).blocked(play)).toBeUndefined();
      // Music turned off altogether says so, whatever the helpers.
      expect(await new CommandDispatcher([], [], services({ config: { music: { enabled: false } } as never })).blocked(play)).toBe('Music is turned off for now.');
    });

    it('lets the command try if helpers cannot be checked', async () => {
      const broken = { blocker: async () => Promise.reject(new Error('database is down')) } as unknown as HelperDesk;
      await new CommandDispatcher([play], [], services({ musicHelpers: broken })).runCommand(play, context(ALICE, 'Alice'));
      expect(replies.at(-1)).toBe('playing');
    });
  });
});
