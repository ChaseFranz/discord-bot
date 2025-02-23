import { CommandInteraction, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { Logger } from 'winston';

interface IResetCommand {
  data: {
    name: string;
    description: string;
  };
  usage: string;
  execute(interaction: CommandInteraction, conversationHistories: Map<string, any>, openai: any, logger: Logger): Promise<void>;
}

class ResetCommand implements IResetCommand {
  data = {
    name: 'reset',
    description: 'Reset your conversation context',
  };

  usage = '/reset - Clears your current conversation context so you can start fresh.';

  async execute(interaction: CommandInteraction, conversationHistories: Map<string, any>, openai: any, logger: Logger): Promise<void> {
    const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
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
    await interaction.editReply({ content: 'Are you sure you want to reset your conversation context?', components: [confirmRow] });
  }
}

export default new ResetCommand();
