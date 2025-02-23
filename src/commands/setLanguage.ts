import { SlashCommandBuilder, SlashCommandOptionsOnlyBuilder } from 'discord.js';
import { CommandInteraction } from 'discord.js';

interface ISetLanguageCommand {
  data: SlashCommandOptionsOnlyBuilder;
  usage: string;
  execute(interaction: CommandInteraction, conversationHistories: Map<string, any>, openai: any, logger: any, client: any, userSettings: Map<string, any>): Promise<void>;
}

class SetLanguageCommand implements ISetLanguageCommand {
  data: SlashCommandOptionsOnlyBuilder;
  usage: string;

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName('setlanguage')
      .setDescription('Set your preferred language for ChatGPT responses')
      .addStringOption(option =>
        option
          .setName('language')
          .setDescription('Select a language')
          .setRequired(true)
          .addChoices(
            { name: 'English', value: 'en' },
            { name: 'Spanish', value: 'es' },
            { name: 'French', value: 'fr' },
            { name: 'German', value: 'de' }
          )
      );
    this.usage = '/setlanguage language: <en|es|fr|de> - e.g., /setlanguage language: es';
  }

  async execute(interaction: CommandInteraction, conversationHistories: Map<string, any>, openai: any, logger: any, client: any, userSettings: Map<string, any>): Promise<void> {
    if (!interaction.channel) {
        await interaction.reply({ content: 'Channel information is missing.', ephemeral: true });
        return;
      }

    const conversationKey = `${interaction.user.id}-${interaction.channel.id}`;
    const language = interaction.options.get('language')?.value as string;
    
    // Retrieve current settings or initialize defaults.
    const settings = userSettings.get(conversationKey) || { temperature: 0.7, style: 'default', language: 'en' };
    settings.language = language;
    userSettings.set(conversationKey, settings);

    // Define language-specific system instructions.
    const languageInstructions = {
      en: "You are ChatGPT, a helpful assistant. Base your response on the most recent user prompt.",
      es: "Eres ChatGPT, un asistente servicial. Basa tu respuesta en el mensaje más reciente del usuario.",
      fr: "Vous êtes ChatGPT, un assistant utile. Basez votre réponse sur la dernière demande de l'utilisateur.",
      de: "Du bist ChatGPT, ein hilfreicher Assistent. Beziehe deine Antwort auf die neueste Benutzeranfrage."
    };

    const newInstruction = languageInstructions[language as 'en' | 'es' | 'fr' | 'de'] || languageInstructions['en'];

    // Clear the conversation history and set only the new system instruction.
    conversationHistories.set(conversationKey, [{ role: 'system', content: newInstruction }]);

    logger.info(`User ${interaction.user.tag} set language to ${language} and cleared conversation history.`);
    await interaction.editReply({ content: `Language has been set to ${language} and conversation context cleared.`});
  }
}

export default new SetLanguageCommand();
