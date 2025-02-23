import { SlashCommandBuilder } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('customize')
    .setDescription('Customize ChatGPT responses with temperature and style settings')
    .addNumberOption(option => 
      option
        .setName('temperature')
        .setDescription('Set the temperature (0 to 1, default 0.7)')
        .setMinValue(0)
        .setMaxValue(1)
    )
    .addStringOption(option =>
      option
        .setName('style')
        .setDescription('Select a conversational style')
        .addChoices(
          { name: 'Default', value: 'default' },
          { name: 'Casual', value: 'casual' },
          { name: 'Formal', value: 'formal' },
          { name: 'Humorous', value: 'humorous' },
          { name: 'Sarcastic', value: 'sarcastic' }
        )
    ),
  usage: '/customize temperature: <0-1> style: <default|casual|formal|humorous|sarcastic> - e.g., /customize temperature: 0.8 style: casual',
  async execute(interaction, conversationHistories, openai, logger, client, userSettings) {
    const conversationKey = `${interaction.user.id}-${interaction.channel.id}`;
    // Get current settings, or initialize with defaults
    const settings = userSettings.get(conversationKey) || { temperature: 0.7, style: 'default' };
    
    const tempOption = interaction.options.getNumber('temperature');
    const styleOption = interaction.options.getString('style');
    
    if (tempOption !== null) {
      settings.temperature = tempOption;
    }
    if (styleOption) {
      settings.style = styleOption;
    }
    userSettings.set(conversationKey, settings);
    
    // Update conversation history system instruction accordingly
    const styleInstructions = {
      default: "You are ChatGPT, a helpful assistant. Base your response on the most recent user prompt.",
      casual: "You are ChatGPT, a friendly and casual assistant. Respond in a relaxed, conversational tone.",
      formal: "You are ChatGPT, a professional and formal assistant. Provide detailed, precise responses.",
      humorous: "You are ChatGPT, a witty and humorous assistant. Inject light-hearted humor in your responses.",
      sarcastic: "You are ChatGPT, a sarcastic and dry-witted assistant. Respond with a touch of irony and wit."
    };
    
    const newInstruction = styleInstructions[settings.style] || styleInstructions['default'];
    let history = conversationHistories.get(conversationKey) || [];
    if (history.length > 0 && history[0].role === 'system') {
      history[0].content = newInstruction;
    } else {
      history.unshift({ role: 'system', content: newInstruction });
    }
    conversationHistories.set(conversationKey, history);
    
    logger.info(`User ${interaction.user.tag} customized settings: Temperature=${settings.temperature}, Style=${settings.style}`);
    await interaction.editReply({ content: `Settings updated: Temperature = ${settings.temperature}, Style = ${settings.style}`, ephemeral: true });
  },
};
