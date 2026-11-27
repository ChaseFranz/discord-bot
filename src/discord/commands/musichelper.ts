import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import type { HelperDesk } from '../../music/relay/HelperDesk.js';
import type { HelperRegistration } from '../../music/relay/ports.js';
import { MUSIC_TURNED_OFF } from '../../music/types.js';
import type { BotCommand } from '../types.js';

const ACTIONS = { status: 'status', newCode: 'new-code', remove: 'remove' } as const;

/** Setting up and checking on music helpers. Everything it says is shown only to the person who asked. */
export const musicHelperCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('musichelper')
    .setDescription('Set up or check the helper that fetches music through your own computer')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('action')
        .setDescription('What to do (default: show who is running one, and how to set yours up)')
        .addChoices(
          { name: 'Status and setup', value: ACTIONS.status },
          { name: 'New code (replaces your old one)', value: ACTIONS.newCode },
          { name: 'Remove my helper', value: ACTIONS.remove },
        ),
    ),
  usage: '/musichelper - Shows who is running a music helper and how to set up your own.',
  ephemeral: true,
  cooldownSeconds: 5,

  async execute(context, services) {
    const desk = services.musicHelpers;
    if (!desk) {
      await context.editReply(
        services.config.music.enabled ? "This copy of Nimbus fetches music itself, so there's no helper to set up. Just use `/play`." : MUSIC_TURNED_OFF,
      );
      return;
    }
    const action = context.string('action') ?? ACTIONS.status;
    if (action === ACTIONS.remove) {
      const removed = await desk.remove(context.userId);
      await context.editReply(
        removed ? 'Your music helper is removed: its code no longer works. `/musichelper` sets up a new one.' : "You don't have a music helper set up.",
      );
      return;
    }

    const existing = await desk.registration(context.userId);
    // A code can only be shown when it's made (just a hash of it is kept), so: on first use, or on request.
    const code = action === ACTIONS.newCode || !existing ? await desk.issue(context.userId, context.displayName) : undefined;
    if (code) services.logger.info(`${context.userTag} got a music helper code.`);
    const running = await desk.online();
    await context.editReply(render(desk, running, existing, code));
  },
};

function render(desk: HelperDesk, running: readonly HelperRegistration[], existing: HelperRegistration | undefined, code: string | undefined): string {
  const lines = [
    '**Music helper**',
    "YouTube won't send audio to the servers Nimbus runs on, so music is fetched by a small helper that someone in the server runs on their own computer. " +
      'While one is running, `/play` and "Nimbus, play…" work for everyone.',
    '',
    running.length > 0
      ? `**Running now:** ${running.map((helper) => `${helper.userName} (checked in ${ago(helper.lastSeenAt)})`).join(', ')}`
      : "**Running now:** nobody's.",
  ];
  if (code) {
    lines.push(
      '',
      existing ? '**Your new code** (the old one has stopped working):' : '**To set yours up** (once, about two minutes):',
      '1. Install Node.js 22 or newer: <https://nodejs.org>',
      `2. Download \`nimbus-music-helper.mjs\` from <${desk.guideUrl}>`,
      '3. In a terminal, in the folder you saved it to, run:',
      '```',
      `node nimbus-music-helper.mjs ${code}`,
      '```',
      'It remembers the code, so after that `node nimbus-music-helper.mjs` is enough. Keep it running while you want music.',
      '',
      "This code is yours alone, so don't share it: whoever has it can play audio through Nimbus as you. " +
        '`/musichelper action:New code` replaces it, and `action:Remove my helper` switches it off.',
    );
  } else if (existing) {
    lines.push(
      '',
      `**Yours:** set up ${ago(existing.createdAt)}, ${existing.lastSeenAt === null ? 'never run yet' : `last running ${ago(existing.lastSeenAt)}`}. ` +
        'Start it with `node nimbus-music-helper.mjs`.',
      `Lost the code? \`/musichelper action:New code\` gives you a fresh one. Instructions: <${desk.guideUrl}>`,
    );
  }
  return lines.join('\n');
}

/** A moment as Discord shows it ("3 minutes ago"), in the reader's own clock. */
function ago(epochMs: number | null): string {
  return epochMs === null ? 'never' : `<t:${Math.floor(epochMs / 1000)}:R>`;
}
