import { SlashCommandBuilder, SlashCommandOptionsOnlyBuilder } from '@discordjs/builders';
import { CommandInteraction } from 'discord.js';
import { IBotCommand } from './types/DiscordModels';

// Define the interface
interface ICustomizeCommand extends IBotCommand {
  data: SlashCommandOptionsOnlyBuilder;
  usage: string;
  execute(interaction: CommandInteraction, conversationHistories: Map<string, any>, openai: any, logger: any, client: any, userSettings: Map<string, any>): Promise<void>;
}

class CustomizeCommand implements ICustomizeCommand {
  data: SlashCommandOptionsOnlyBuilder;
  usage: string;

  constructor() {
    this.data = new SlashCommandBuilder()
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
      );
    this.usage = '/customize temperature: <0-1> style: <default|casual|formal|humorous|sarcastic> - e.g., /customize temperature: 0.8 style: casual';
  }

  async execute(interaction: CommandInteraction, conversationHistories: Map<string, any>, openai: any, logger: any, client: any, userSettings: Map<string, any>): Promise<void> {
    if (!interaction.channel) {
      await interaction.reply({ content: 'Channel information is missing.', ephemeral: true });
      return;
    }
    const conversationKey = `${interaction.user.id}-${interaction.channel.id}`;
    type StyleType = 'default' | 'casual' | 'formal' | 'humorous' | 'sarcastic';
    const settings = userSettings.get(conversationKey) || { temperature: 0.7, style: 'default' as const };
    
    const tempOption = interaction.options.get('temperature')?.value as number | null;
    const styleOption = interaction.options.get('style')?.value as string;
    
    if (tempOption !== null) {
      settings.temperature = tempOption;
    }
    if (styleOption) {
      settings.style = styleOption;
    }
    userSettings.set(conversationKey, settings);
    
    const styleInstructions = {
      default: "You are ChatGPT, a helpful assistant. Base your response on the most recent user prompt.",
      casual: "You are ChatGPT, a friendly and casual assistant. Respond in a relaxed, conversational tone.",
      formal: "You are ChatGPT, a professional and formal assistant. Provide detailed, precise responses.",
      humorous: "You are ChatGPT, a witty and humorous assistant. Inject light-hearted humor in your responses.",
      sarcastic: "You are ChatGPT, a sarcastic and dry-witted assistant. Respond with a touch of irony and wit."
    };
    
    const newInstruction = styleInstructions[settings.style as StyleType] || styleInstructions['default'];
    let history = conversationHistories.get(conversationKey) || [];
    if (history.length > 0 && history[0].role === 'system') {
      history[0].content = newInstruction;
    } else {
      history.unshift({ role: 'system', content: newInstruction });
    }
    conversationHistories.set(conversationKey, history);
    
    logger.info(`User ${interaction.user.tag} customized settings: Temperature=${settings.temperature}, Style=${settings.style}`);
    await interaction.editReply({ content: `Settings updated: Temperature = ${settings.temperature}, Style = ${settings.style}`});
  }
}

export default new CustomizeCommand();
