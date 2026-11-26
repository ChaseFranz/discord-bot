import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { truncate } from '../../util/text.js';
import type { AppServices, BotCommand, ComponentHandler } from '../types.js';

const PREFIX = 'memories';
/** Discord select menus hold at most 25 options. */
const SHOWN = 25;

interface MemoriesView {
  content: string;
  embeds: EmbedBuilder[];
  components: Array<ActionRowBuilder<MessageActionRowComponentBuilder>>;
}

/** /memories: shows (only to you) what the assistant remembers about you, with controls to forget it. */
export const memoriesCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('memories')
    .setDescription('See and delete what the assistant remembers about you')
    .setContexts(InteractionContextType.Guild),
  usage: '/memories - Shows what the assistant remembers about you, with options to forget it.',
  ephemeral: true,

  async execute(interaction, services) {
    await interaction.editReply(await memoriesView(services, interaction.guildId, interaction.user.id));
  },
};

/** The forget menu and buttons on the /memories message. */
export const memoriesComponents: ComponentHandler = {
  prefix: PREFIX,
  async execute(interaction, services) {
    const { guildId } = interaction;
    const userId = interaction.user.id;
    const name = services.config.assistant.name;
    const action = interaction.customId.slice(PREFIX.length + 1);

    if (action === 'forget' && interaction.isStringSelectMenu()) {
      const id = Number(interaction.values[0]);
      const memory = Number.isInteger(id) ? await services.memories.get(guildId, id) : undefined;
      let notice = 'That note was already gone.';
      // The menu only lists your own notes, but check again: only notes about you can be removed here.
      if (memory && memory.subjectId === userId) {
        await services.memories.delete(guildId, memory.id);
        services.logger.info(`${interaction.user.tag} deleted memory #${memory.id} about themselves.`);
        notice = `Forgot: "${truncate(memory.text, 80)}"`;
      }
      await interaction.update(await memoriesView(services, guildId, userId, notice));
    } else if (action === 'forget-all') {
      await interaction.update({
        content: `Forget everything ${name} remembers about you? This can't be undone.`,
        embeds: [],
        components: [
          new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`${PREFIX}:forget-all-confirm`).setLabel('Yes, forget everything').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`${PREFIX}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    } else if (action === 'forget-all-confirm') {
      const count = await services.memories.deleteAllAbout(guildId, userId);
      services.logger.info(`${interaction.user.tag} deleted all ${count} memories about themselves.`);
      await interaction.update({
        content: `Done. ${name} forgot ${count} note${count === 1 ? '' : 's'} about you.`,
        embeds: [],
        components: [],
      });
    } else if (action === 'cancel') {
      await interaction.update(await memoriesView(services, guildId, userId));
    }
  },
};

async function memoriesView(services: AppServices, guildId: string, userId: string, notice?: string): Promise<MemoriesView> {
  const name = services.config.assistant.name;
  const [memories, total] = await Promise.all([
    services.memories.listAbout(guildId, [userId], SHOWN),
    services.memories.countAbout(guildId, userId),
  ]);
  const prefix = notice ? `${notice}\n` : '';
  if (memories.length === 0) {
    return { content: `${prefix}${name} doesn't remember anything about you yet.`, embeds: [], components: [] };
  }

  const source = (sourceUserId: string, sourceName: string) => (sourceUserId === userId ? 'you said' : `from ${sourceName}`);
  const lines = memories.map(
    (memory) =>
      `**#${memory.id}** ${truncate(memory.text, 160)} · ${source(memory.sourceUserId, memory.sourceName)}, ` +
      `${new Date(memory.updatedAt).toISOString().slice(0, 10)}`,
  );
  const footer = `${total > SHOWN ? `Showing the ${SHOWN} most recent of ${total}. ` : ''}Anyone in this server can ask ${name} about these.`;
  const embed = new EmbedBuilder()
    .setTitle(`What ${name} remembers about you`)
    .setColor(0x8f6bff)
    .setDescription(truncate(lines.join('\n'), 4000))
    .setFooter({ text: footer });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}:forget`)
    .setPlaceholder('Forget a note…')
    .addOptions(
      memories.map((memory) => ({
        label: truncate(memory.text, 100),
        description: truncate(`#${memory.id} · ${source(memory.sourceUserId, memory.sourceName)}`, 100),
        value: String(memory.id),
      })),
    );
  const buttons = new ButtonBuilder().setCustomId(`${PREFIX}:forget-all`).setLabel('Forget everything about me').setStyle(ButtonStyle.Danger);

  return {
    content: notice ?? '',
    embeds: [embed],
    components: [
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu),
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(buttons),
    ],
  };
}
