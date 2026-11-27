import type { Source } from '../assistant/history.js';
import { truncate } from '../util/text.js';
import type { AppServices } from './types.js';

/** A markdown list of web sources, for the end of a text reply. */
export function formatSources(sources: readonly Source[]): string {
  const lines = sources.slice(0, 8).map((source) => `- [${truncate(source.title.replace(/[[\]]/g, ''), 80)}](${source.url})`);
  return `**Sources**\n${lines.join('\n')}`;
}

/** What to say instead of answering once today's budget is used up. */
export function budgetPausedMessage(services: AppServices, guildId: string): string {
  const status = services.usage.status(guildId);
  const name = services.config.assistant.name;
  return (
    `${name} has reached today's spending limit ($${(status.budgetUsd ?? 0).toFixed(2)}), so it's taking a break ` +
    `until <t:${Math.floor(status.resetsAt / 1000)}:t>. Music and other commands still work.`
  );
}

/** A short note for the end of a text reply when the server is close to its daily budget. */
export function budgetNote(services: AppServices, guildId: string): string | undefined {
  const status = services.usage.status(guildId);
  if (status.budgetUsd === null) return undefined;
  if (status.state === 'paused') {
    return `That used up today's budget; ${services.config.assistant.name} is taking a break until <t:${Math.floor(status.resetsAt / 1000)}:t>.`;
  }
  if (status.state === 'warning') {
    return `${Math.round((status.spentUsd / status.budgetUsd) * 100)}% of today's $${status.budgetUsd.toFixed(2)} budget is used.`;
  }
  return undefined;
}
