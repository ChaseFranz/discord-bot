import { ContextMenuCommandBuilder, ApplicationCommandType, EmbedBuilder, CommandInteraction, Message, MessageContextMenuCommandInteraction } from 'discord.js';
import { Logger } from 'winston';
import OpenAI from 'openai';
import { OpenAIModel } from './types/openAIModel.js';

interface ISummarizeMessageCommand {
  data: ContextMenuCommandBuilder;
  usage: string;
  execute(interaction: CommandInteraction, openai: OpenAI, logger: Logger): Promise<void>;
}

class SummarizeMessageCommand implements ISummarizeMessageCommand {
  data = new ContextMenuCommandBuilder()
    .setName('Summarize This Message')
    .setType(ApplicationCommandType.Message);

  usage = 'Right-click a message and select "Summarize This Message" to get a concise one-sentence summary.';

  async execute(interaction: MessageContextMenuCommandInteraction, openai: OpenAI, logger: Logger): Promise<void> {
    const targetMessage = interaction.targetMessage;
    if (!targetMessage) {
      await interaction.reply({ content: "Couldn't retrieve the selected message.", ephemeral: true });
      return;
    }

    const prompt = `Summarize the following message in one sentence: ${targetMessage.content}`;

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: "You are ChatGPT, a summarization assistant. Provide a concise one-sentence summary of the provided text." },
      { role: 'user', content: prompt }
    ];

    try {
      const response = await openai.chat.completions.create({
        model: OpenAIModel.GPT_3_5_TURBO,
        messages: messages,
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
  }
}

export default new SummarizeMessageCommand();
