import { ContextMenuCommandBuilder, ApplicationCommandType, EmbedBuilder, CommandInteraction, Message, MessageContextMenuCommandInteraction, TextChannel, ChannelType } from 'discord.js';
import { Logger } from 'winston';

interface IConextChatCommand {
  data: ContextMenuCommandBuilder;
  execute(interaction: CommandInteraction, conversationHistories: Map<string, any>, openai: any, logger: Logger, userSettings: any): Promise<void>;
}

class ContextChatCommand implements IConextChatCommand {
  data = new ContextMenuCommandBuilder()
    .setName('ChatGPT This Message')
    .setType(ApplicationCommandType.Message);

  async execute(interaction: CommandInteraction, conversationHistories: Map<string, any>, openai: any, logger: Logger, userSettings: any): Promise<void> {
    const messageInteraction = interaction as MessageContextMenuCommandInteraction;
    const targetMessage = messageInteraction.targetMessage as Message;
    if (!targetMessage) {
      await interaction.reply({ content: "Couldn't retrieve the selected message.", ephemeral: true });
      return;
    }

    const prompt = targetMessage.content.trim();
    if (!prompt) {
      await interaction.reply({ content: "The selected message is empty.", ephemeral: true });
      return;
    }

    const conversationKey = `${interaction.user.id}-${interaction.channelId}`;
    let history = conversationHistories.get(conversationKey) || [];

    if (history.length === 0 || history[0].role !== 'system') {
      history.unshift({
        role: 'system',
        content: "You are ChatGPT, a helpful assistant. Base your response on the most recent prompt. If the prompt seems unrelated to previous context, treat it as a new query.",
      });
    }

    history.push({ role: 'user', content: prompt });
    const MAX_HISTORY_LENGTH = 20;
    if (history.length > MAX_HISTORY_LENGTH) {
      history = [history[0], ...history.slice(-(MAX_HISTORY_LENGTH - 1))];
    }

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }
    if (interaction.channel?.type === ChannelType.GuildText) {
      await (interaction.channel as TextChannel).sendTyping();
    }

    const settings = userSettings.get(conversationKey) || { temperature: 0.7 };

    logger.info(`User ${interaction.user.tag} used context menu on a message with prompt: "${prompt}"`);

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: history,
        temperature: settings.temperature,
      });
      const reply = response.choices[0].message.content;
      history.push({ role: 'assistant', content: reply });
      conversationHistories.set(conversationKey, history);

      const replyEmbed = new EmbedBuilder()
        .setTitle('ChatGPT Response')
        .setDescription(reply)
        .setColor(0x00AE86)
        .setFooter({ text: 'Powered by ChatGPT' });

      await interaction.editReply({ embeds: [replyEmbed] });
      logger.info(`Context menu command processed for ${interaction.user.tag}`);
    } catch (error) {
      logger.error(`Error in context command for ${interaction.user.tag}: ${error}`);
      await interaction.editReply('Sorry, an error occurred while processing the message.');
    }
  }
}

export default new ContextChatCommand();
