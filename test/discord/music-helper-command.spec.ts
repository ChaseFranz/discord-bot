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
const DOWNLOADS = 'https://raw.example/nimbus/main/helper';

describe('/musichelper', () => {
  const clock = fakeClock(Date.UTC(2026, 10, 27, 20, 0, 0));
  let registry: MemoryHelperRegistry;
  let desk: HelperDesk;
  let replies: Reply[];

  beforeEach(() => {
    clock.set(Date.UTC(2026, 10, 27, 20, 0, 0));
    registry = new MemoryHelperRegistry();
    desk = new HelperDesk({ guildId: GUILD, registry, clock, apiUrl: 'https://helper.example/', guideUrl: GUIDE, downloadUrl: DOWNLOADS });
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
  /** The setup code shown in a reply, if there is one: it is in both lines that start a helper, Windows' and everyone else's. */
  const codeIn = (reply: string) => {
    const windows = /install\.ps1\)\)\) (nimbus1\.[\w-]+)"/.exec(reply)?.[1];
    const unix = /install\.sh \| sh -s -- (nimbus1\.[\w-]+)/.exec(reply)?.[1];
    expect(windows).toBe(unix);
    return unix;
  };

  it('is shown only to the person who used it', () => {
    expect(musicHelperCommand.ephemeral).toBe(true);
    expect(EPHEMERAL_COMMANDS.has('musichelper')).toBe(true);
  });

  it('gives a first-time user their code in the one line that sets the helper up and starts it', async () => {
    const reply = await run(ALICE, 'Alice');
    expect(reply).toContain("**Running now:** nobody's.");
    expect(reply).toContain('**To set yours up** (once, a few minutes), paste the line for your computer into a terminal and press Enter:');
    const code = codeIn(reply)!;
    expect(reply).toContain(
      ['Windows (PowerShell, Terminal or Command Prompt):', '```', `powershell -c "& ([scriptblock]::Create((irm ${DOWNLOADS}/install.ps1))) ${code}"`, '```'].join('\n'),
    );
    expect(reply).toContain(['macOS or Linux:', '```', `curl -fsSL ${DOWNLOADS}/install.sh | sh -s -- ${code}`, '```'].join('\n'));
    expect(reply).toContain('start it again later with the same line, without the code.');
    expect(reply).toContain(`how to set it up by hand instead: <${GUIDE}>`);
    expect(reply).toContain("don't share it");

    const setup = parseSetupCode(code)!;
    expect(setup.apiUrl).toBe('https://helper.example/');
    const token = parseToken(setup.token)!;
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
    // How to start it again, without a code: the one it has is saved.
    expect(status).toContain(`\npowershell -c "& ([scriptblock]::Create((irm ${DOWNLOADS}/install.ps1)))"\n`);
    expect(status).toContain(`\ncurl -fsSL ${DOWNLOADS}/install.sh | sh\n`);
    expect(status).toContain('(Or `node nimbus-music-helper.mjs`, if you set it up by hand.)');
    expect(status).toContain('Lost the code? `/musichelper action:New code` gives you a fresh one.');
    // The code they have still works.
    expect(secretMatches(parseToken(parseSetupCode(first)!.token)!.secret, (await registry.find(GUILD, ALICE))!.secretHash)).toBe(true);

    const fresh = await run(ALICE, 'Alice', 'new-code');
    expect(fresh).toContain('**Your new code** (the old one has stopped working). Start your helper with the line for your computer:');
    expect(codeIn(fresh)).not.toBe(first);
    expect(secretMatches(parseToken(parseSetupCode(first)!.token)!.secret, (await registry.find(GUILD, ALICE))!.secretHash)).toBe(false);
  });

  it('fits in one Discord message, with real-length addresses and codes and many helpers running', async () => {
    desk = new HelperDesk({
      guildId: GUILD, registry, clock, apiUrl: 'https://abcdefghijklmnopqrstuvwxyz012345.lambda-url.us-east-1.on.aws/', guideUrl: GUIDE,
      downloadUrl: 'https://raw.githubusercontent.com/ChaseFranz/discord-bot/main/helper',
    });
    // Display names are at most 32 characters, and ids 19 digits for years to come.
    for (let helper = 0; helper < 5; helper++) {
      const userId = `200000000000000000${helper}`;
      await desk.issue(userId, `Somebody with a long name, no. ${helper}`);
      await registry.checkIn(GUILD, userId, clock() - helper * 1_000, '1.2.0');
    }
    const someone = '3000000000000000001';
    const first = await run(someone, 'Someone');
    expect(codeIn(first)).toBeDefined();
    expect(first).toContain(', and 2 more');
    for (const reply of [first, await run(someone, 'Someone', 'new-code'), await run(someone, 'Someone')]) {
      expect(reply.length).toBeLessThanOrEqual(2_000);
    }
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
