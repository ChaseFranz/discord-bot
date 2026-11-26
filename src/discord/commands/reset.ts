import { ActionRowBuilder, ButtonBuilder, ButtonStyle, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import type { BotCommand, ComponentHandler } from '../types.js';

const PREFIX = 'reset';

export const resetCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Reset your conversation with the assistant (text and voice)')
    .setContexts(InteractionContextType.Guild),
  usage: '/reset - Clears your conversation so you can start fresh.',

  async execute(interaction, services) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}:confirm`).setLabel('Yes, Reset').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`${PREFIX}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    services.logger.info(`${interaction.user.tag} requested reset confirmation.`);
    await interaction.editReply({ content: 'Are you sure you want to reset your conversation context?', components: [row] });
  },
};

/** The confirm/cancel buttons. Clicking always resets the clicker's own conversation. */
export const resetButtons: ComponentHandler = {
  prefix: PREFIX,
  async execute(interaction, services) {
    if (interaction.customId === `${PREFIX}:confirm`) {
      await services.conversations.reset({ guildId: interaction.guildId, userId: interaction.user.id });
      services.logger.info(`${interaction.user.tag} reset their conversation.`);
      await interaction.update({
        content: `Your conversation context has been reset. (Long-term notes about you are in /memories.)`,
        components: [],
      });
    } else {
      await interaction.update({ content: 'Reset canceled.', components: [] });
    }
  },
};
