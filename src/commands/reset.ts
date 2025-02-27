import { CommandInteraction, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, SharedSlashCommand } from 'discord.js';
import OpenAI from 'openai';
import { Logger } from 'winston';
import { IBotCommand } from './types/DiscordModels';

interface IResetCommand extends IBotCommand {
  data: SlashCommandBuilder;
  usage: string;
  execute(
    interaction: CommandInteraction, 
    conversationHistories: Map<string, any>, 
    openai: OpenAI, 
    logger: Logger): Promise<void>;
}

class ResetCommand implements IResetCommand {
  data: SlashCommandBuilder;
  usage: string;
  
  constructor() {
    this.data = new SlashCommandBuilder()
      .setName('reset')
      .setDescription('Reset your conversation context');

    this.usage = '/reset - Clears your current conversation context so you can start fresh.';
  }

  async execute(
    interaction: CommandInteraction, 
    conversationHistories: Map<string, any>, 
    openai: OpenAI, 
    logger: Logger): Promise<void> {
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
