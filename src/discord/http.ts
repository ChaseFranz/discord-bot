import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ComponentType,
  InteractionType,
  MessageFlags,
  REST,
  Routes,
  type APIChatInputApplicationCommandGuildInteraction,
  type APIInteraction,
  type APIMessageComponentGuildInteraction,
  type APIUser,
} from 'discord.js';
import type { ReminderMessenger } from '../reminders/ReminderDelivery.js';
import { toApiBody, type CallInfo, type CommandContext, type ComponentContext, type Reply, type VoiceChannelInfo } from './context.js';

/**
 * Interactions delivered over HTTPS (Discord's "Interactions Endpoint URL"), as Lambda receives
 * them: request signatures, the immediate response Discord needs within 3 seconds, and command
 * contexts that answer through the REST API with the interaction token.
 */

/** The slice of Discord's REST API the HTTP side uses; fakeable in tests. */
export interface DiscordRestApi {
  get(route: `/${string}`): Promise<unknown>;
  post(route: `/${string}`, body: unknown, options?: { auth?: boolean }): Promise<unknown>;
  patch(route: `/${string}`, body: unknown, options?: { auth?: boolean }): Promise<unknown>;
}

export function createDiscordRest(token: string): DiscordRestApi {
  const rest = new REST({ version: '10' }).setToken(token);
  return {
    get: (route) => rest.get(route),
    post: (route, body, options) => rest.post(route, { body, auth: options?.auth ?? true }),
    patch: (route, body, options) => rest.patch(route, { body, auth: options?.auth ?? true }),
  };
}

export function isChatInputGuildCommand(interaction: APIInteraction): interaction is APIChatInputApplicationCommandGuildInteraction {
  return (
    interaction.type === InteractionType.ApplicationCommand &&
    interaction.data.type === ApplicationCommandType.ChatInput &&
    'guild_id' in interaction &&
    interaction.guild_id !== undefined &&
    'member' in interaction &&
    interaction.member !== undefined
  );
}

export function isGuildComponent(interaction: APIInteraction): interaction is APIMessageComponentGuildInteraction {
  return (
    interaction.type === InteractionType.MessageComponent &&
    'guild_id' in interaction &&
    interaction.guild_id !== undefined &&
    'member' in interaction &&
    interaction.member !== undefined
  );
}

interface HttpContextDeps {
  rest: DiscordRestApi;
  applicationId: string;
}

/** Replies never ping anyone: model-written text can't summon @everyone or a stray mention. */
const NO_PINGS = { allowed_mentions: { parse: [] } };

export function httpCommandContext(
  interaction: APIChatInputApplicationCommandGuildInteraction,
  deps: HttpContextDeps & { ephemeral: boolean },
): CommandContext {
  const user = interaction.member.user;
  const original = Routes.webhookMessage(deps.applicationId, interaction.token, '@original');
  return {
    commandName: interaction.data.name,
    guildId: interaction.guild_id,
    userId: user.id,
    userTag: tagOf(user),
    displayName: interaction.member.nick ?? user.global_name ?? user.username,
    channelId: interaction.channel?.id ?? interaction.channel_id ?? '',
    channelName: interaction.channel && 'name' in interaction.channel ? (interaction.channel.name ?? undefined) : undefined,
    string: (name) => {
      const option = interaction.data.options?.find((candidate) => candidate.name === name);
      return option && option.type === ApplicationCommandOptionType.String ? option.value : null;
    },
    editReply: async (reply) => {
      await afterAcknowledged(() => deps.rest.patch(original, body(reply), { auth: false }));
    },
    followUp: async (reply) => {
      const payload = { ...body(reply), ...(deps.ephemeral ? { flags: MessageFlags.Ephemeral } : {}) };
      await afterAcknowledged(() => deps.rest.post(Routes.webhook(deps.applicationId, interaction.token), payload, { auth: false }));
    },
  };
}

export function httpComponentContext(interaction: APIMessageComponentGuildInteraction, deps: HttpContextDeps): ComponentContext {
  const user = interaction.member.user;
  const select = interaction.data.component_type === ComponentType.StringSelect;
  return {
    guildId: interaction.guild_id,
    userId: user.id,
    userTag: tagOf(user),
    customId: interaction.data.custom_id,
    kind: select ? 'select' : 'button',
    values: select && 'values' in interaction.data ? interaction.data.values : [],
    // The deferred update leaves the message as is; editing @original replaces it.
    update: async (reply) => {
      await afterAcknowledged(() =>
        deps.rest.patch(Routes.webhookMessage(deps.applicationId, interaction.token, '@original'), body(reply), { auth: false }),
      );
    },
    notify: async (message) => {
      const payload = { content: message, flags: MessageFlags.Ephemeral, ...NO_PINGS };
      await afterAcknowledged(() => deps.rest.post(Routes.webhook(deps.applicationId, interaction.token), payload, { auth: false }));
    },
  };
}

/**
 * Lambda hands the work on just before it answers Discord's request, so a fast reply can reach
 * Discord before its "thinking…" has been processed; Discord then says 404. Retry briefly on that.
 */
async function afterAcknowledged<T>(send: () => Promise<T>, attempts = 6, delayMs = 250): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if ((error as { status?: number }).status !== 404 || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

function body(reply: Reply) {
  return { ...toApiBody(reply), ...NO_PINGS };
}

function tagOf(user: APIUser): string {
  return user.discriminator && user.discriminator !== '0' ? `${user.username}#${user.discriminator}` : user.username;
}

/** The live call the voice task reports, if it's running. */
export interface CallPresence {
  get(guildId: string): Promise<{ channelId: string; channelName: string; people: Array<{ id: string; name: string }>; music: string } | undefined>;
}

/**
 * Call state for Lambda, which has no live connection: Discord's REST API says which channel a
 * person is in, and the voice task's status record says who else is there and what's playing.
 */
export class RestCallInfo implements CallInfo {
  constructor(
    private readonly rest: DiscordRestApi,
    private readonly presence: CallPresence,
  ) {}

  async voiceChannelOf(guildId: string, userId: string): Promise<VoiceChannelInfo | undefined> {
    let state: { channel_id?: string | null };
    try {
      state = (await this.rest.get(Routes.guildVoiceState(guildId, userId))) as { channel_id?: string | null };
    } catch (error) {
      // 404 means they aren't in a voice channel.
      if ((error as { status?: number }).status === 404) return undefined;
      throw error;
    }
    const channelId = state.channel_id;
    if (!channelId) return undefined;
    const call = await this.presence.get(guildId);
    if (call?.channelId === channelId) return { id: channelId, name: call.channelName, people: call.people };
    const channel = (await this.rest.get(Routes.channel(channelId))) as { name?: string | null };
    return { id: channelId, name: channel.name ?? 'voice channel', people: [] };
  }

  async musicStatus(guildId: string): Promise<string> {
    return (await this.presence.get(guildId))?.music ?? 'nothing playing';
  }
}

/** Reminder messages sent through the REST API (no live connection needed). */
export class RestMessenger implements ReminderMessenger {
  constructor(private readonly rest: DiscordRestApi) {}

  async postInChannel(guildId: string, channelId: string, content: string, mentionUserId: string): Promise<void> {
    const channel = (await this.rest.get(Routes.channel(channelId))) as { guild_id?: string };
    if (channel.guild_id !== guildId) throw new Error('channel not found in this server');
    await this.rest.post(Routes.channelMessages(channelId), { content, allowed_mentions: { users: [mentionUserId] } });
  }

  async sendDirect(userId: string, content: string): Promise<void> {
    const dm = (await this.rest.post(Routes.userChannels(), { recipient_id: userId })) as { id: string };
    await this.rest.post(Routes.channelMessages(dm.id), { content, ...NO_PINGS });
  }
}
