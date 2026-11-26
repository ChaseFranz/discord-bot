import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import type { Source } from '../../assistant/history.js';
import { chunkText, truncate } from '../../util/text.js';
import type { BotCommand } from '../types.js';

const MIN_PROMPT = 3;
const MAX_PROMPT = 200;
/** Embed descriptions allow 4,096 characters; leave headroom. */
const EMBED_CHUNK = 4_000;
const EMBED_COLOR = 0x00ae86;

export const chatCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Talk with the assistant (shares your conversation with voice)')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('prompt')
        .setDescription('Your message')
        .setRequired(true)
        .setMinLength(MIN_PROMPT)
        .setMaxLength(MAX_PROMPT),
    ),
  usage: '/chat prompt: Tell me a funny joke about cats.',

  async execute(interaction, services) {
    const prompt = interaction.options.getString('prompt', true).trim();
    if (prompt.length < MIN_PROMPT) {
      await interaction.editReply({ content: 'Your prompt is too short!' });
      return;
    }
    if (prompt.length > MAX_PROMPT) {
      await interaction.editReply({ content: `Your prompt is too long! Please limit it to ${MAX_PROMPT} characters.` });
      return;
    }

    const member = interaction.member;
    const voiceChannel = member.voice.channel;
    services.logger.info(`${interaction.user.tag} /chat: "${prompt}"`);

    const reply = await services.assistant.respond({
      scope: { guildId: interaction.guildId, userId: interaction.user.id },
      modality: 'text',
      userDisplayName: member.displayName,
      text: prompt,
      channelName: interaction.channel?.name,
      userVoiceChannelId: voiceChannel?.id,
      userVoiceChannelName: voiceChannel?.name,
      peoplePresent: voiceChannel
        ? [...voiceChannel.members.values()].filter((m) => !m.user.bot).map((m) => ({ id: m.id, name: m.displayName }))
        : [],
      musicStatus: services.music.describe(interaction.guildId),
    });

    let body = reply.text;
    if (body.length === 0) body = reply.silent ? '*(Stopped talking.)*' : '*(No reply.)*';
    if (reply.sources.length > 0) body += `\n\n${formatSources(reply.sources)}`;

    const footer = [
      `${services.config.assistant.name} · powered by Claude`,
      reply.outcome === 'truncated' ? 'reply was cut off' : undefined,
    ]
      .filter(Boolean)
      .join(' · ');

    const chunks = chunkText(body, EMBED_CHUNK);
    const embeds = chunks.map((chunk, index) => {
      const embed = new EmbedBuilder().setColor(EMBED_COLOR).setDescription(chunk);
      if (index === 0) embed.setTitle(services.config.assistant.name);
      if (index === chunks.length - 1) embed.setFooter({ text: footer });
      return embed;
    });

    await interaction.editReply({ embeds: [embeds[0]!] });
    for (const embed of embeds.slice(1)) {
      await interaction.followUp({ embeds: [embed] });
    }
    services.logger.info(`Replied to ${interaction.user.tag} (${reply.model}, ${reply.outcome})`);
  },
};

function formatSources(sources: Source[]): string {
  const lines = sources.slice(0, 8).map((source) => `- [${truncate(source.title.replace(/[[\]]/g, ''), 80)}](${source.url})`);
  return `**Sources**\n${lines.join('\n')}`;
}
