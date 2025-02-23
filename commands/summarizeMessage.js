import { ContextMenuCommandBuilder, ApplicationCommandType, EmbedBuilder } from 'discord.js';

export default {
  data: new ContextMenuCommandBuilder()
    .setName('Summarize This Message')
    .setType(ApplicationCommandType.Message),
    usage: 'Right-click a message and select "Summarize This Message" to get a concise one-sentence summary.',
  async execute(interaction, conversationHistories, openai, logger, client, userSettings) {
    // Get the target message.
    const targetMessage = interaction.targetMessage;
    if (!targetMessage) {
      return interaction.reply({ content: "Couldn't retrieve the selected message.", ephemeral: true });
    }
    
    // Create a prompt to summarize the message.
    const prompt = `Summarize the following message in one sentence: ${targetMessage.content}`;
    
    // Prepare messages for ChatGPT.
    const messages = [
      { role: 'system', content: "You are ChatGPT, a summarization assistant. Provide a concise one-sentence summary of the provided text." },
      { role: 'user', content: prompt }
    ];
    
    // Do NOT call interaction.deferReply() here since the main event handler already deferred.
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages,
      });
      const summary = response.choices[0].message.content;
      const embed = new EmbedBuilder()
        .setTitle('Message Summary')
        .setDescription(summary)
        .setColor(0x00AE86)
        .setFooter({ text: 'Summarized by ChatGPT' });
      
      await interaction.editReply({ embeds: [embed] });
      logger.info(`Summarized message for ${interaction.user.tag}`);
    } catch (error) {
      logger.error(`Error summarizing message: ${error}`);
      await interaction.editReply({ content: 'Sorry, an error occurred while summarizing the message.' });
    }
  },
};
