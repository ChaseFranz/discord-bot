import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import type { Assistant } from '../assistant/Assistant.js';
import type { AppConfig } from '../config/config.js';
import type { Logger } from '../logging/logger.js';
import type { MusicService } from '../music/MusicService.js';
import type { PrivacyService } from '../privacy/PrivacyService.js';
import type { ConversationRepository, MemoryRepository, SettingsRepository } from '../storage/ports.js';
import type { UsageService } from '../usage/UsageService.js';
import type { VoiceSessionManager } from '../voice/VoiceSessionManager.js';
import type { CallInfo, CommandContext, ComponentContext } from './context.js';

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
  /** Who is in which voice channel, and what music is doing. */
  calls: CallInfo;
  /**
   * The voice connection and music, where calls are handled: the bot on a PC, or the voice task on
   * AWS. Absent in Lambda, which passes voice commands on instead of running them.
   */
  voice?: VoiceSessionManager;
  music?: MusicService;
  /** All registered slash commands (for /help). */
  commands: () => readonly BotCommand[];
  /** Whether @mentioning the bot gets an answer here (it needs the live connection, so not on AWS). */
  mentionChat: boolean;
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
  /**
   * Needs the voice connection. 'starts-call' commands (/join, /play) can bring the voice task up
   * on AWS; 'in-call' ones only make sense while it's running.
   */
  readonly voice?: 'starts-call' | 'in-call';
  /** Runs after the interaction has been deferred; reply with editReply/followUp. */
  execute(context: CommandContext, services: AppServices): Promise<void>;
}

export interface ComponentHandler {
  /** Handles buttons and select menus whose customId starts with `${prefix}:`. */
  readonly prefix: string;
  execute(context: ComponentContext, services: AppServices): Promise<void>;
}

/** The voice connection and music, for commands that only run where calls are handled. */
export function requireVoice(services: AppServices): { voice: VoiceSessionManager; music: MusicService } {
  if (!services.voice || !services.music) throw new Error('This command needs the voice connection, which this process does not have.');
  return { voice: services.voice, music: services.music };
}
