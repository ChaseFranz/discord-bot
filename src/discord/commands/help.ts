import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { truncate } from '../../util/text.js';
import { unavailableReason, type BotCommand } from '../types.js';

export const helpCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('List all available commands with details')
    .setContexts(InteractionContextType.Guild),
  usage: '/help - Displays this help message with usage examples.',

  async execute(context, services) {
    const name = services.config.assistant.name;
    const embed = new EmbedBuilder()
      .setTitle('Help - Available Commands')
      .setColor(0x0099ff)
      .setDescription(
        `Use **/join** and I'll listen in your voice channel. Say "${name}" to talk to me; ` +
          'I remember what each of you tells me and can look back over what was said in the call. ' +
          (services.mentionChat
            ? `You can also type to me with **/chat**, or mention **@${name}** in any channel (images welcome).`
            : 'You can also type to me with **/chat**.'),
      )
      .setFooter({ text: 'Use these commands to interact with the bot.' })
      .setTimestamp();

    const fields = services.commands().map((command) => {
      const json = command.data.toJSON();
      const options = (json.options ?? []).map((option) => `**${option.name}**: ${option.description}`).join('\n');
      const value = `${json.description}${options ? `\n**Options:**\n${options}` : ''}\n**Usage:** ${command.usage}`;
      const off = unavailableReason(command, services.config) ? ' (turned off)' : '';
      return { name: `/${json.name}${off}`, value: truncate(value, 1024) };
    });
    embed.addFields(fields.slice(0, 25));

    services.logger.info(`${context.userTag} requested help.`);
    await context.editReply({ embeds: [embed] });
  },
};
