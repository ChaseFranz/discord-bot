import { CommandInteraction, EmbedBuilder, SlashCommandBuilder, CommandInteractionOptionResolver, ChannelType, TextChannel } from 'discord.js';
import { Logger } from 'winston';
import OpenAI from 'openai';
import { OpenAIModel } from './types/openAIModel.js';

class ChatCommand {
  data = new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Have a conversation with ChatGPT')
    .addStringOption(option =>
      option
        .setName('prompt')
        .setDescription('Your message to ChatGPT')
        .setRequired(true)
    );

  usage = '/chat <prompt> - e.g., /chat Tell me a funny joke about cats.';
  cooldown = 5;

  async execute(interaction: CommandInteraction, conversationHistories: Map<string, any>, openai: OpenAI, logger: Logger, client: any, userSettings: any): Promise<void> {
    const prompt = (interaction.options as CommandInteractionOptionResolver).getString('prompt')?.trim();
    if (!prompt) {
      await interaction.editReply({ content: 'Your prompt is invalid!'});
    }
    if (prompt && prompt.length < 3) {
      await interaction.editReply({ content: 'Your prompt is too short!'});
    }
    if (prompt && prompt.length > 200) {
      await interaction.editReply({ content: 'Your prompt is too long! Please limit it to 200 characters.'});
    }
    const conversationKey = `${interaction.user.id}-${interaction.channelId}`;
    let history = conversationHistories.get(conversationKey) || [];

    // Inject system instruction if not already present
    if (history.length === 0 || history[0].role !== 'system') {
      history.unshift({
        role: 'system',
        content: "You are ChatGPT, a helpful assistant. Base your response on the most recent user prompt. If the prompt seems unrelated to previous context, treat it as a new query.",
      });
    }

    history.push({ role: 'user', content: prompt });
    const MAX_HISTORY_LENGTH = 20;
    if (history.length > MAX_HISTORY_LENGTH) {
      history = [history[0], ...history.slice(-(MAX_HISTORY_LENGTH - 1))];
    }
    if (interaction.channel?.type === ChannelType.GuildText) {
      await (interaction.channel as TextChannel).sendTyping();
    }
    logger.info(`User ${interaction.user.tag} initiated chat with prompt: "${prompt}"`);

    // Retrieve user's temperature setting (default to 0.7)
    const settings = userSettings.get(conversationKey) || { temperature: 0.7 };

    try {
      const response = await openai.chat.completions.create({
        model: OpenAIModel.GPT_3_5_TURBO,
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
      logger.info(`Replied to ${interaction.user.tag}`);
    } catch (error) {
      logger.error(`Error from OpenAI for ${interaction.user.tag}: ${error}`);
      await interaction.editReply('Sorry, I encountered an error processing your request.');
    }
  }
}

export default new ChatCommand();
