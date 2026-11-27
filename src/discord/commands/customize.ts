import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { STYLES, isStyleId } from '../../assistant/styles.js';
import type { BotCommand } from '../types.js';

export const customizeCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('customize')
    .setDescription('Choose how the assistant talks to you, in text and voice')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('style')
        .setDescription('Conversational style')
        .setRequired(true)
        .addChoices(...Object.entries(STYLES).map(([value, style]) => ({ name: style.label, value }))),
    ),
  usage: '/customize style: Casual',

  async execute(context, services) {
    const style = context.string('style') ?? '';
    if (!isStyleId(style)) {
      await context.editReply('Unknown style.');
      return;
    }
    await services.settings.update({ guildId: context.guildId, userId: context.userId }, { style });
    services.logger.info(`${context.userTag} set style=${style}`);
    await context.editReply(`Settings updated: Style = ${STYLES[style].label}`);
  },
};
