import { isoUtc } from '../util/time.js';

/** Looks up names for the IDs in a message's mentions. */
export interface MentionLookup {
  botId: string;
  assistantName: string;
  userName(id: string): string | undefined;
  roleName(id: string): string | undefined;
  channelName(id: string): string | undefined;
}

/**
 * Rewrites Discord's mention syntax into text the model can read: `<@123>` becomes
 * `@Sam (user 123)`, roles and channels become their names, custom emoji become `:name:`, and
 * timestamps become ISO times. A mention of the bot at the start or end is dropped (it's how the
 * message is addressed); one in the middle becomes the assistant's name.
 */
export function resolveMentions(content: string, lookup: MentionLookup): string {
  const botMention = new RegExp(`<@!?${lookup.botId}>`, 'g');
  let text = content
    .trim()
    .replace(new RegExp(`^(?:<@!?${lookup.botId}>[\\s,:]*)+`), '')
    .replace(new RegExp(`(?:[\\s,]*<@!?${lookup.botId}>)+[\\s.!?]*$`), '')
    .replace(botMention, lookup.assistantName);
  text = text.replace(/<@!?(\d+)>/g, (match, id: string) => {
    const name = lookup.userName(id);
    return name ? `@${oneLine(name)} (user ${id})` : `@user ${id}`;
  });
  text = text.replace(/<@&(\d+)>/g, (_match, id: string) => `@${oneLine(lookup.roleName(id) ?? 'a role')}`);
  text = text.replace(/<#(\d+)>/g, (_match, id: string) => `#${oneLine(lookup.channelName(id) ?? 'a channel')}`);
  text = text.replace(/<a?:(\w+):\d+>/g, ':$1:');
  text = text.replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, (_match, seconds: string) => isoUtc(Number(seconds) * 1000));
  return text.trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
