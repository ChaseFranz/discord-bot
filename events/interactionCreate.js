export default {
    name: 'interactionCreate',
    async execute(interaction, client) {
      const { logger, conversationHistories, openai, userSettings, cooldowns, commands } = client;
    
      // Handle slash commands.
      if (interaction.isCommand()) {
        const command = commands.get(interaction.commandName);
        if (!command) return;
    
        // Implement command cooldowns (default is 3 seconds, or command.cooldown).
        const now = Date.now();
        const cooldownAmount = ((command.cooldown || 3) * 1000);
        if (!cooldowns.has(command.data.name)) {
          cooldowns.set(command.data.name, new Map());
        }
        const timestamps = cooldowns.get(command.data.name);
        const userId = interaction.user.id;
        if (timestamps.has(userId)) {
          const expirationTime = timestamps.get(userId) + cooldownAmount;
          if (now < expirationTime) {
            const timeLeft = ((expirationTime - now) / 1000).toFixed(1);
            return interaction.reply({ content: `Please wait ${timeLeft} more second(s) before using \`${command.data.name}\` again.`, ephemeral: true });
          }
        }
        timestamps.set(userId, now);
        setTimeout(() => timestamps.delete(userId), cooldownAmount);
    
        try {
          // Only defer if it hasn't been already.
          if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
          }
          await command.execute(interaction, conversationHistories, openai, logger, client, userSettings);
        } catch (error) {
          logger.error(`Error executing command ${interaction.commandName}: ${error}`);
          await interaction.editReply('There was an error executing that command.');
        }
      }
    
      // Handle button interactions for reset confirmation.
      if (interaction.isButton()) {
        if (interaction.customId === 'confirmReset') {
          const conversationKey = `${interaction.user.id}-${interaction.channel.id}`;
          conversationHistories.delete(conversationKey);
          logger.info(`User ${interaction.user.tag} confirmed reset of conversation history.`);
          await interaction.update({ content: 'Your conversation context has been reset.', components: [] });
        } else if (interaction.customId === 'cancelReset') {
          logger.info(`User ${interaction.user.tag} canceled the reset action.`);
          await interaction.update({ content: 'Reset canceled.', components: [] });
        }
      }
    
      // Handle select menu interactions if needed.
      // if (interaction.isStringSelectMenu()) { ... }
    },
  };
  