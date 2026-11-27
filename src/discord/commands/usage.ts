import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import type { UsageReport } from '../../usage/UsageService.js';
import type { BotCommand } from '../types.js';

/** /usage: today's estimated spending (Claude, transcription, speech, web search) against the daily budget. */
export const usageCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('usage')
    .setDescription("See today's estimated spending and the daily budget")
    .setContexts(InteractionContextType.Guild),
  usage: '/usage - Shows what the assistant has spent today and over the last week.',
  ephemeral: true,

  async execute(interaction, services) {
    const report = await services.usage.report(interaction.guildId);
    await interaction.editReply({ embeds: [usageEmbed(report, services.config.assistant.name)] });
  },
};

export function usageEmbed(report: UsageReport, assistantName: string): EmbedBuilder {
  const { status } = report;
  const resets = `<t:${Math.floor(status.resetsAt / 1000)}:t>`;
  const budgetLine =
    status.budgetUsd === null
      ? `**${usd(status.spentUsd)}** today (no daily cap set).`
      : `**${usd(status.spentUsd)}** of the **${usd(status.budgetUsd)}** daily budget (${Math.round((status.spentUsd / status.budgetUsd) * 100)}%). ` +
        (status.state === 'paused'
          ? `${assistantName} is paused until ${resets}.`
          : status.state === 'warning'
            ? `Getting close; it resets at ${resets}.`
            : `Resets at ${resets}.`);

  const claude =
    report.claude.length === 0
      ? 'No requests yet.'
      : report.claude
          .map(
            (model) =>
              `\`${model.model}\` · ${count(model.requests)} request${model.requests === 1 ? '' : 's'} · ` +
              `${tokens(model.inputTokens + model.cacheReadTokens + model.cacheWriteTokens)} in ` +
              `(${tokens(model.cacheReadTokens)} from cache) · ${tokens(model.outputTokens)} out · **${usd(model.costUsd)}**`,
          )
          .join('\n');

  const minutes = report.transcription.seconds / 60;
  const weekTotal = report.week.reduce((sum, day) => sum + day.costUsd, 0);
  const week = report.week.length > 0 ? report.week.map((day) => `${day.day.slice(5)} ${usd(day.costUsd)}`).join(' · ') : 'Nothing yet.';

  return new EmbedBuilder()
    .setTitle(`${assistantName} usage today`)
    .setColor(status.state === 'paused' ? 0xd9534f : status.state === 'warning' ? 0xf0ad4e : 0x5cb85c)
    .setDescription(budgetLine)
    .addFields(
      { name: 'Claude', value: claude.slice(0, 1024) },
      { name: 'Web searches', value: `${count(report.webSearch.requests)} · ${usd(report.webSearch.costUsd)}`, inline: true },
      { name: 'Transcription', value: `${minutes.toFixed(1)} min · ${usd(report.transcription.costUsd)}`, inline: true },
      { name: 'Speech', value: `${count(report.speech.characters)} characters · ${usd(report.speech.costUsd)}`, inline: true },
      { name: `Last 7 days: ${usd(weekTotal)}`, value: week.slice(0, 1024) },
    )
    .setFooter({ text: 'Estimates from list prices. Your Anthropic and AWS bills are authoritative.' });
}

function usd(amount: number): string {
  return amount < 0.01 && amount > 0 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
}

function count(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function tokens(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : `${Math.round(value)}`;
}
