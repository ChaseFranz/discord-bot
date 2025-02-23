import { ContextMenuCommandBuilder, ApplicationCommandType, EmbedBuilder } from 'discord.js';

export default {
  data: new ContextMenuCommandBuilder()
    .setName('ChatGPT This Message')
    .setType(ApplicationCommandType.Message),
  async execute(interaction, conversationHistories, openai, logger, client, userSettings) {
    const targetMessage = interaction.targetMessage;
    if (!targetMessage) {
      return interaction.reply({ content: "Couldn't retrieve the selected message.", ephemeral: true });
    }
    
    const prompt = targetMessage.content.trim();
    if (!prompt) {
      return interaction.reply({ content: "The selected message is empty.", ephemeral: true });
    }
    
    const conversationKey = `${interaction.user.id}-${interaction.channel.id}`;
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
    await interaction.channel.sendTyping();
    
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
  },
};
