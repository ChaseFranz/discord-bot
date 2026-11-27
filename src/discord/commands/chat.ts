import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { BudgetExceededError } from '../../assistant/Assistant.js';
import { chunkText } from '../../util/text.js';
import { budgetNote, budgetPausedMessage, formatSources } from '../textChat.js';
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

  async execute(context, services) {
    const prompt = (context.string('prompt') ?? '').trim();
    if (prompt.length < MIN_PROMPT) {
      await context.editReply('Your prompt is too short!');
      return;
    }
    if (prompt.length > MAX_PROMPT) {
      await context.editReply(`Your prompt is too long! Please limit it to ${MAX_PROMPT} characters.`);
      return;
    }
    if (services.usage.isPaused(context.guildId)) {
      await context.editReply(budgetPausedMessage(services, context.guildId));
      return;
    }

    services.logger.info(`${context.userTag} /chat: "${prompt}"`);
    const [call, musicStatus] = await Promise.all([
      services.calls.voiceChannelOf(context.guildId, context.userId),
      services.calls.musicStatus(context.guildId),
    ]);

    let reply;
    try {
      reply = await services.assistant.respond({
        scope: { guildId: context.guildId, userId: context.userId },
        userDisplayName: context.displayName,
        text: prompt,
        channelName: context.channelName,
        textChannelId: context.channelId,
        userVoiceChannelId: call?.id,
        userVoiceChannelName: call?.name,
        peoplePresent: call?.people ?? [],
        musicStatus,
      });
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      await context.editReply(budgetPausedMessage(services, context.guildId));
      return;
    }

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

    const note = budgetNote(services, context.guildId);
    await context.editReply({ embeds: [embeds[0]!], ...(note && embeds.length === 1 ? { content: `-# ${note}` } : {}) });
    for (const [index, embed] of embeds.slice(1).entries()) {
      const last = index === embeds.length - 2;
      await context.followUp({ embeds: [embed], ...(note && last ? { content: `-# ${note}` } : {}) });
    }
    services.logger.info(`Replied to ${context.userTag} (${reply.model}, ${reply.outcome})`);
  },
};
