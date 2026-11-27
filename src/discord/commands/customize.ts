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

  async execute(interaction, services) {
    const style = interaction.options.getString('style', true);
    if (!isStyleId(style)) {
      await interaction.editReply({ content: 'Unknown style.' });
      return;
    }
    await services.settings.update({ guildId: interaction.guildId, userId: interaction.user.id }, { style });
    services.logger.info(`${interaction.user.tag} set style=${style}`);
    await interaction.editReply({ content: `Settings updated: Style = ${STYLES[style].label}` });
  },
};
