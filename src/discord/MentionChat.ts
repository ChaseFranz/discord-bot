import { MessageFlags, type Attachment, type Message } from 'discord.js';
import { BudgetExceededError, type AttachedImage } from '../assistant/Assistant.js';
import { describeError } from '../logging/logger.js';
import { chunkText, truncate } from '../util/text.js';
import { resolveMentions } from './mentions.js';
import { budgetNote, budgetPausedMessage, formatSources, voiceContextOf } from './textChat.js';
import type { AppServices } from './types.js';

/** Discord's message length limit for bots. */
const MESSAGE_LIMIT = 2_000;
/** Claude accepts images up to 5 MB and 8,000 pixels on a side. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_SIDE = 8_000;
const MAX_IMAGES = 4;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const DOWNLOAD_TIMEOUT_MS = 15_000;
const TYPING_REFRESH_MS = 8_000;
/** A person can have this many messages waiting for an answer; more get a "one at a time" note. */
const MAX_PENDING_PER_PERSON = 2;
const MAX_QUOTE = 500;

export interface MentionChatOptions {
  /** The only server the bot answers in (the one its slash commands are registered in). */
  guildId: string;
  botUserId: () => string;
  fetch?: typeof fetch;
}

/**
 * Chat by @mention: anyone who mentions the bot (or replies to one of its messages with the ping on)
 * in a channel or thread gets an answer as a reply, sharing their one conversation thread with /chat
 * and voice. Discord delivers the content of messages that mention a bot without the privileged
 * Message Content intent, so no extra permission is needed.
 */
export class MentionChat {
  private readonly pending = new Map<string, number>();
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly services: AppServices,
    private readonly options: MentionChatOptions,
  ) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  readonly handle = async (message: Message): Promise<void> => {
    if (!message.inGuild() || message.guildId !== this.options.guildId) return;
    if (message.author.bot || message.system || message.webhookId) return;
    const botId = this.options.botUserId();
    if (!this.addressesBot(message, botId)) return;

    const { services } = this;
    const userId = message.author.id;
    const waiting = this.pending.get(userId) ?? 0;
    if (waiting >= MAX_PENDING_PER_PERSON) {
      await this.send(message, ["I'm still working on your last message; one at a time, please."]);
      return;
    }
    if (services.usage.isPaused(message.guildId)) {
      await this.send(message, [budgetPausedMessage(services, message.guildId)]);
      return;
    }

    this.pending.set(userId, waiting + 1);
    const typing = this.keepTyping(message);
    try {
      await this.answer(message, botId);
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        await this.send(message, [budgetPausedMessage(services, message.guildId)]);
      } else {
        services.logger.error(`Answering a mention from ${message.author.tag} failed: ${describeError(error)}`);
        await this.send(message, ['Sorry, something went wrong on my end.']);
      }
    } finally {
      typing();
      const left = (this.pending.get(userId) ?? 1) - 1;
      if (left > 0) this.pending.set(userId, left);
      else this.pending.delete(userId);
    }
  };

  private addressesBot(message: Message<true>, botId: string): boolean {
    // Explicit mentions, and replies with the ping on. (A reply with the ping off doesn't count:
    // without the Message Content intent its text arrives empty.)
    if (message.mentions.users.has(botId)) return true;
    // People sometimes pick the bot's role from the mention list instead of the bot itself.
    const botRole = message.guild.members.me?.roles.botRole;
    return botRole !== undefined && botRole !== null && message.mentions.roles.has(botRole.id);
  }

  private async answer(message: Message<true>, botId: string): Promise<void> {
    const { services } = this;
    const member = message.member ?? (await message.guild.members.fetch(message.author.id));
    const name = services.config.assistant.name;
    const lookup = {
      botId,
      assistantName: name,
      userName: (id: string) => message.mentions.members?.get(id)?.displayName ?? message.mentions.users.get(id)?.displayName,
      roleName: (id: string) => message.mentions.roles.get(id)?.name ?? message.guild.roles.cache.get(id)?.name,
      channelName: (id: string) => {
        const channel = message.guild.channels.cache.get(id);
        return channel && 'name' in channel ? channel.name : undefined;
      },
    };

    const parts: string[] = [];
    const quoted = await this.quotedMessage(message, botId, lookup);
    if (quoted) parts.push(quoted);
    const text = resolveMentions(message.content, lookup);
    if (text) parts.push(text);
    const { images, notes } = await this.readAttachments([...message.attachments.values()]);
    parts.push(...notes);
    if (parts.length === 0 && images.length === 0) {
      await this.send(message, [`Hi! Ask me anything by mentioning me, like "@${name} what's a good movie tonight?"`]);
      return;
    }

    services.logger.info(`${message.author.tag} mentioned ${name} in #${message.channel.name}: "${truncate(text, 200)}"`);
    const reply = await services.assistant.respond({
      scope: { guildId: message.guildId, userId: message.author.id },
      modality: 'text',
      userDisplayName: member.displayName,
      text: parts.join('\n'),
      images,
      channelName: message.channel.name,
      textChannelId: message.channelId,
      ...voiceContextOf(member),
      musicStatus: services.music.describe(message.guildId),
    });

    let body = reply.text.length > 0 ? reply.text : reply.silent ? '*(Stopped.)*' : '*(No reply.)*';
    if (reply.sources.length > 0) body += `\n\n${formatSources(reply.sources)}`;
    const notesAfter = [
      reply.outcome === 'truncated' ? 'The reply was cut off.' : undefined,
      budgetNote(services, message.guildId),
    ].filter((note): note is string => note !== undefined);
    if (notesAfter.length > 0) body += `\n${notesAfter.map((note) => `-# ${note}`).join('\n')}`;
    await this.send(message, chunkText(body, MESSAGE_LIMIT));
    services.logger.info(`Replied to ${message.author.tag} (${reply.model}, ${reply.outcome})`);
  }

  /** The message being replied to, quoted, when Discord lets the bot read it. */
  private async quotedMessage(
    message: Message<true>,
    botId: string,
    lookup: Parameters<typeof resolveMentions>[1],
  ): Promise<string | undefined> {
    if (!message.reference?.messageId) return undefined;
    const referenced = await message.fetchReference().catch(() => undefined);
    // Without the Message Content intent, other people's messages come back empty unless they mention the bot.
    const content = referenced?.content ? resolveMentions(referenced.content, lookup) : '';
    if (!referenced || content.length === 0) return undefined;
    const author = referenced.author.id === botId ? 'your earlier message' : (referenced.member?.displayName ?? referenced.author.displayName);
    return `(Replying to ${author}: "${truncate(content.replace(/\s+/g, ' '), MAX_QUOTE)}")`;
  }

  private async readAttachments(attachments: readonly Attachment[]): Promise<{ images: AttachedImage[]; notes: string[] }> {
    const images: AttachedImage[] = [];
    const notes: string[] = [];
    for (const attachment of attachments) {
      const type = attachment.contentType?.split(';')[0]?.trim().toLowerCase();
      if (!type || !IMAGE_TYPES.has(type)) {
        notes.push(`(Attached ${attachment.name}, which you can't open.)`);
        continue;
      }
      if (images.length >= MAX_IMAGES) {
        notes.push(`(Attached image ${attachment.name}; only the first ${MAX_IMAGES} images are shown to you.)`);
        continue;
      }
      if (attachment.size > MAX_IMAGE_BYTES || (attachment.width ?? 0) > MAX_IMAGE_SIDE || (attachment.height ?? 0) > MAX_IMAGE_SIDE) {
        notes.push(`(Attached image ${attachment.name}, too large for you to view.)`);
        continue;
      }
      try {
        const response = await this.fetchImpl(attachment.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error('too large');
        images.push({ name: attachment.name, mediaType: type as AttachedImage['mediaType'], data: bytes.toString('base64') });
      } catch (error) {
        this.services.logger.warn(`Could not download ${attachment.name}: ${describeError(error)}`);
        notes.push(`(Attached image ${attachment.name}, which couldn't be loaded.)`);
      }
    }
    return { images, notes };
  }

  /** Replies to the message (pinging only its author), falling back to a plain send if replying fails. */
  private async send(message: Message<true>, chunks: readonly string[]): Promise<void> {
    for (const [index, content] of chunks.entries()) {
      const options = { content, allowedMentions: { parse: [], repliedUser: index === 0 }, flags: MessageFlags.SuppressEmbeds } as const;
      try {
        if (index === 0) await message.reply({ ...options, failIfNotExists: false });
        else await message.channel.send({ ...options, allowedMentions: { parse: [] } });
      } catch (error) {
        if (index > 0) throw error;
        this.services.logger.warn(`Could not reply in #${message.channel.name}, sending instead: ${describeError(error)}`);
        await message.channel.send({ ...options, allowedMentions: { parse: [] } });
      }
    }
  }

  /** Shows "Nimbus is typing…" until the returned function is called. */
  private keepTyping(message: Message<true>): () => void {
    const type = () => void message.channel.sendTyping().catch(() => undefined);
    type();
    const timer = setInterval(type, TYPING_REFRESH_MS);
    timer.unref();
    return () => clearInterval(timer);
  }
}
