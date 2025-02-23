import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export default {
  data: {
    name: 'reset',
    description: 'Reset your conversation context',
  },
  usage: '/reset - Clears your current conversation context so you can start fresh.',
  async execute(interaction, conversationHistories, openai, logger) {
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('confirmReset')
        .setLabel('Yes, Reset')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('cancelReset')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );
    logger.info(`User ${interaction.user.tag} requested reset confirmation.`);
    await interaction.editReply({ content: 'Are you sure you want to reset your conversation context?', components: [confirmRow], ephemeral: true });
  },
};
