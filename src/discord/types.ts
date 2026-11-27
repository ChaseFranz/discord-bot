import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  StringSelectMenuInteraction,
} from 'discord.js';
import type { Assistant } from '../assistant/Assistant.js';
import type { AppConfig } from '../config/config.js';
import type { Logger } from '../logging/logger.js';
import type { MusicService } from '../music/MusicService.js';
import type { PrivacyService } from '../privacy/PrivacyService.js';
import type { ConversationRepository, MemoryRepository, SettingsRepository } from '../storage/ports.js';
import type { UsageService } from '../usage/UsageService.js';
import type { VoiceSessionManager } from '../voice/VoiceSessionManager.js';

/** Everything a command can use. Passed explicitly instead of hanging properties off the client. */
export interface AppServices {
  config: AppConfig;
  logger: Logger;
  assistant: Assistant;
  conversations: ConversationRepository;
  settings: SettingsRepository;
  memories: MemoryRepository;
  privacy: PrivacyService;
  usage: UsageService;
  voice: VoiceSessionManager;
  music: MusicService;
  /** All registered slash commands (for /help). */
  commands: () => readonly BotCommand[];
}

export interface CommandBuilder {
  readonly name: string;
  readonly description: string;
  toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody;
}

export interface BotCommand {
  readonly data: CommandBuilder;
  /** Example shown by /help. */
  readonly usage: string;
  /** Per-user cooldown in seconds (default 3). */
  readonly cooldownSeconds?: number;
  /** Defer the reply as ephemeral (only the invoking user sees it). */
  readonly ephemeral?: boolean;
  /** Runs after the interaction has been deferred; reply with editReply/followUp. */
  execute(interaction: ChatInputCommandInteraction<'cached'>, services: AppServices): Promise<void>;
}

export type ComponentInteraction = ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'>;

export interface ComponentHandler {
  /** Handles buttons and select menus whose customId starts with `${prefix}:`. */
  readonly prefix: string;
  execute(interaction: ComponentInteraction, services: AppServices): Promise<void>;
}
