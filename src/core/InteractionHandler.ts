import { 
  Interaction, 
  Client, 
  ChatInputCommandInteraction, 
  ButtonInteraction, 
  StringSelectMenuInteraction 
} from 'discord.js';
import { Logger } from 'winston';

/**
 * InteractionHandler class to handle various types of interactions
 * such as commands, buttons, and select menus.
 */
export class InteractionHandler {
  private logger: Logger;
  private conversationHistories: Map<string, any[]>;
  private openai: any;
  private userSettings: Map<string, any>;
  private cooldowns: Map<string, Map<string, number>>;
  private commands: any;

  /**
   * Constructor to initialize the InteractionHandler with the client.
   * @param {Client} client - The Discord client instance.
   */
  constructor(client: Client) {
    // Access custom properties attached to the client.
    const custom = client as any;
    this.logger = custom.logger;
    this.conversationHistories = custom.conversationHistories;
    this.openai = custom.openai;
    this.userSettings = custom.userSettings;
    this.cooldowns = custom.cooldowns;
    this.commands = custom.commands;
  }

  /**
   * Handles different types of interactions.
   * @param {Interaction} interaction - The interaction to handle.
   * @param {Client} client - The Discord client instance.
   */
  public async handle(interaction: Interaction, client: Client): Promise<void> {
    if (interaction.isCommand()) {
      await this.handleCommand(interaction as ChatInputCommandInteraction, client);
    } else if (interaction.isButton()) {
      await this.handleButton(interaction as ButtonInteraction);
    } else if (interaction.isStringSelectMenu()) {
      await this.handleSelectMenu(interaction as StringSelectMenuInteraction);
    }
    // Add other interaction types if needed.
  }

  /**
   * Handles command interactions.
   * @param {ChatInputCommandInteraction} interaction - The command interaction to handle.
   * @param {Client} client - The Discord client instance.
   */
  private async handleCommand(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
    const command = this.commands.get(interaction.commandName);
    if (!command) return;

    // Implement command cooldowns (default: 3 seconds or command.cooldown)
    const now = Date.now();
    const cooldownAmount = ((command.cooldown || 3) * 1000);
    if (!this.cooldowns.has(command.data.name)) {
      this.cooldowns.set(command.data.name, new Map());
    }
    const timestamps: Map<string, number> = this.cooldowns.get(command.data.name)!;
    const userId = interaction.user.id;
    if (timestamps.has(userId)) {
      const expirationTime = timestamps.get(userId)! + cooldownAmount;
      if (now < expirationTime) {
        const timeLeft = ((expirationTime - now) / 1000).toFixed(1);
        await interaction.reply({ 
          content: `Please wait ${timeLeft} more second(s) before using \`${command.data.name}\` again.`, 
          ephemeral: true 
        });
        return;
      }
    }
    timestamps.set(userId, now);
    setTimeout(() => timestamps.delete(userId), cooldownAmount);

    try {
      // Defer if not already deferred.
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply();
      }
      await command.execute(interaction, this.conversationHistories, this.openai, this.logger, client, this.userSettings);
    } catch (error: any) {
      this.logger.error(`Error executing command ${interaction.commandName}: ${error}`);
      await interaction.editReply('There was an error executing that command.');
    }
  }

  /**
   * Handles button interactions.
   * @param {ButtonInteraction} interaction - The button interaction to handle.
   */
  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId === 'confirmReset') {
      const conversationKey = `${interaction.user.id}-${interaction.channel?.id}`;
      this.conversationHistories.delete(conversationKey);
      this.logger.info(`User ${interaction.user.tag} confirmed reset of conversation history.`);
      await interaction.update({ content: 'Your conversation context has been reset.', components: [] });
    } else if (interaction.customId === 'cancelReset') {
      this.logger.info(`User ${interaction.user.tag} canceled the reset action.`);
      await interaction.update({ content: 'Reset canceled.', components: [] });
    }
  }

  /**
   * Handles select menu interactions.
   * @param {StringSelectMenuInteraction} interaction - The select menu interaction to handle.
   */
  private async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    // Handle select menu interactions if needed.
    this.logger.info(`Received a select menu interaction from ${interaction.user.tag}`);
    await interaction.reply({ content: 'Select menu interaction handled.', ephemeral: true });
  }
}
