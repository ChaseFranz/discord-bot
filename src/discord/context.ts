import type { APIActionRowComponent, APIComponentInMessageActionRow, APIEmbed, JSONEncodable } from 'discord.js';

/**
 * What commands see of an interaction, whichever way it arrived: over the live Gateway connection
 * (the bot on a PC) or as an HTTPS request (Lambda, and commands relayed to the voice task).
 * Commands are deferred before they run, so they answer with editReply/followUp.
 */

export type EmbedLike = APIEmbed | JSONEncodable<APIEmbed>;
export type ComponentRowLike =
  | APIActionRowComponent<APIComponentInMessageActionRow>
  | JSONEncodable<APIActionRowComponent<APIComponentInMessageActionRow>>;

export interface ReplyPayload {
  content?: string;
  embeds?: readonly EmbedLike[];
  components?: readonly ComponentRowLike[];
}

export type Reply = ReplyPayload | string;

export interface CommandContext {
  readonly commandName: string;
  readonly guildId: string;
  readonly userId: string;
  /** For logs, e.g. "alice". */
  readonly userTag: string;
  /** How the person appears in the server. */
  readonly displayName: string;
  readonly channelId: string;
  readonly channelName: string | undefined;
  /** A string option, or null when it wasn't given. */
  string(name: string): string | null;
  /** Replaces the deferred reply. */
  editReply(reply: Reply): Promise<void>;
  /** Sends another message (ephemeral if the command is). */
  followUp(reply: Reply): Promise<void>;
}

export interface ComponentContext {
  readonly guildId: string;
  readonly userId: string;
  readonly userTag: string;
  readonly customId: string;
  readonly kind: 'button' | 'select';
  /** Chosen values of a select menu; empty for buttons. */
  readonly values: readonly string[];
  /** Replaces the message the button or menu is on. */
  update(reply: Reply): Promise<void>;
  /** Tells just the person who clicked something (an error, for example). */
  notify(message: string): Promise<void>;
}

/** The voice channel someone is in, with the people (not bots) in it. */
export interface VoiceChannelInfo {
  id: string;
  name: string;
  people: Array<{ id: string; name: string }>;
}

/** Live call state that commands can ask about, wherever they run. */
export interface CallInfo {
  /** The voice channel a person is in right now, if any. */
  voiceChannelOf(guildId: string, userId: string): Promise<VoiceChannelInfo | undefined>;
  /** What music is doing in the guild, e.g. 'playing "Song" (2 more queued)' or 'nothing playing'. */
  musicStatus(guildId: string): Promise<string>;
}

/** The JSON body Discord's REST API expects for a reply. */
export function toApiBody(reply: Reply): { content?: string; embeds?: APIEmbed[]; components?: Array<APIActionRowComponent<APIComponentInMessageActionRow>> } {
  const payload = typeof reply === 'string' ? { content: reply } : reply;
  return {
    ...(payload.content !== undefined ? { content: payload.content } : {}),
    ...(payload.embeds ? { embeds: payload.embeds.map(toJson) } : {}),
    ...(payload.components ? { components: payload.components.map(toJson) } : {}),
  };
}

function toJson<T>(value: T | JSONEncodable<T>): T {
  return typeof value === 'object' && value !== null && 'toJSON' in value && typeof value.toJSON === 'function'
    ? (value as JSONEncodable<T>).toJSON()
    : (value as T);
}
