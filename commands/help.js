import { EmbedBuilder } from 'discord.js';

export default {
  data: {
    name: 'help',
    description: 'List all available commands with details',
  },
  usage: '/help - Displays this help message with usage examples.',
  async execute(interaction, conversationHistories, openai, logger, client) {
    // Create a base embed.
    const helpEmbed = new EmbedBuilder()
      .setTitle('Help - Available Commands')
      .setColor(0x0099ff)
      .setFooter({ text: 'Use these commands to interact with the bot.' })
      .setTimestamp();
    
    // Build fields dynamically from each command.
    const fields = [];
    client.commands.forEach(command => {
      // For context menu commands, description might be undefined.
      const description = command.data.description || "No description provided.";
      
      // Gather options if any.
      let optionsText = "";
      if (command.data.options && command.data.options.length > 0) {
        optionsText = command.data.options.map(opt => `**${opt.name}**: ${opt.description}`).join("\n");
      }
      
      // Check for a custom usage property; otherwise use a default.
      const usage = command.usage || "No usage example provided.";
      
      // Build a field value that includes description, options (if any), and usage.
      const fieldValue = `${description}\n${optionsText ? "\n**Options:**\n" + optionsText : ""}\n**Usage:** ${usage}`;
      
      fields.push({
        name: `/${command.data.name}`,
        value: fieldValue,
      });
    });
    
    // Add the fields to the embed.
    helpEmbed.addFields(fields);
    
    logger.info(`User ${interaction.user.tag} requested help.`);
    await interaction.editReply({ embeds: [helpEmbed] });
  },
};
