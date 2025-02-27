import { CommandInteraction, EmbedBuilder, SlashCommandBuilder, SlashCommandOptionsOnlyBuilder } from 'discord.js';
import { Logger } from 'winston';
import { IBotCommand } from './types/DiscordModels';

interface IHelpCommand extends IBotCommand {
  data: SlashCommandOptionsOnlyBuilder,
  usage: string,
  execute(
    interaction: CommandInteraction, 
    logger: Logger, 
    client: any): Promise<void>;
}

class HelpCommand implements IHelpCommand {
  public data: SlashCommandOptionsOnlyBuilder;
  public usage: string;

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName('help')
      .setDescription('List all available commands with details');
      this.usage = '/help - Displays this help message with usage examples.';
  }

  async execute(interaction: CommandInteraction, logger: Logger, client: any): Promise<void> {
    const helpEmbed = new EmbedBuilder()
      .setTitle('Help - Available Commands')
      .setColor(0x0099ff)
      .setFooter({ text: 'Use these commands to interact with the bot.' })
      .setTimestamp();

      if (client.commands.size === 0) {
        logger.error('No commands found.');
        await interaction.editReply({ content: 'No commands found.' });
        return;
      }

    const fields = client.commands.map((command: any) => {
      const description = command.data.description || "No description provided.";

      if (!command.data.options){
        logger.info('No options found.');
      } else{
        logger.info('Options found.');
        logger.info(command.data.options);
      }

      const optionsText = (command.data.options || []).map((opt: any) => `**${opt.name}**: ${opt.description}`).join("\n") || "";
      const usage = command.usage || "No usage example provided.";
      const fieldValue = `${description}\n${optionsText ? "\n**Options:**\n" + optionsText : ""}\n**Usage:** ${usage}`;

      return {
        name: `/${command.data.name}`,
        value: fieldValue,
      };
    });

    helpEmbed.addFields(fields);

    logger.info(`User ${interaction.user.tag} requested help.`);
    await interaction.editReply({ embeds: [helpEmbed] });
  }
}

export default new HelpCommand();
