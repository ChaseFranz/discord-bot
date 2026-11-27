import type Anthropic from '@anthropic-ai/sdk';
import { Assistant, type AssistantRoute } from '../assistant/Assistant.js';
import { ToolRegistry } from '../assistant/tools/ToolRegistry.js';
import type { ToolProvider } from '../assistant/tools/types.js';
import { createClaudeClient, describeClaudeAccess, verifyClaudeAccess } from '../claude/client.js';
import type { AppConfig } from '../config/config.js';
import { chatCommand } from '../discord/commands/chat.js';
import { customizeCommand } from '../discord/commands/customize.js';
import { helpCommand } from '../discord/commands/help.js';
import { memoriesCommand, memoriesComponents } from '../discord/commands/memories.js';
import { pauseCommand, playCommand, queueCommand, resumeCommand, skipCommand, stopCommand } from '../discord/commands/music.js';
import { privacyCommand } from '../discord/commands/privacy.js';
import { resetButtons, resetCommand } from '../discord/commands/reset.js';
import { usageCommand } from '../discord/commands/usage.js';
import { joinCommand, leaveCommand } from '../discord/commands/voice.js';
import type { BotCommand, ComponentHandler } from '../discord/types.js';
import { describeError, type Logger } from '../logging/logger.js';
import { connectMemoryTools } from '../memory/inProcess.js';
import { PrivacyService } from '../privacy/PrivacyService.js';
import { openStorage, type Storage } from '../storage/open.js';
import { PriceBook } from '../usage/pricing.js';
import { UsageService } from '../usage/UsageService.js';
import type { Clock } from '../util/time.js';

/** What every process needs: storage, spending, privacy choices, Claude, and the memory tools. */
export interface Core {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  storage: Storage;
  usage: UsageService;
  privacy: PrivacyService;
  claude: Anthropic;
  memory: { provider: ToolProvider; close(): Promise<void> };
  /** The Assistant with the memory tools plus `tools`. */
  assistant(tools: readonly ToolProvider[]): Assistant;
  close(): Promise<void>;
}

/** Builds the assistant's model routes from configuration. */
export function buildRoutes(config: AppConfig): Record<'text' | 'voice', AssistantRoute> {
  const search = config.claude.webSearchEnabled;
  return {
    text: {
      model: config.claude.chat.model,
      effort: config.claude.chat.effort,
      maxTokens: 16_000,
      timeoutMs: 5 * 60_000,
      webSearchMaxUses: search ? 5 : undefined,
    },
    voice: {
      model: config.claude.voice.model,
      effort: config.claude.voice.effort,
      maxTokens: 8_000,
      timeoutMs: 60_000,
      webSearchMaxUses: search ? 2 : undefined,
    },
  };
}

export async function openCore(
  config: AppConfig,
  logger: Logger,
  clock: Clock,
  options: { verifyClaude: boolean } = { verifyClaude: true },
): Promise<Core> {
  const storage = openStorage(config.storage.backend, { retentionDays: config.storage.retentionDays, clock });
  const backend = config.storage.backend;
  logger.info(
    backend.kind === 'dynamodb'
      ? `Storing data in DynamoDB (${backend.table}, ${backend.memoryTable}${backend.endpoint ? ` at ${backend.endpoint}` : ''}).`
      : `Storing data in ${backend.databasePath} and ${backend.memoryDatabasePath}.`,
  );

  const usage = new UsageService({
    repository: storage.usage,
    prices: new PriceBook({
      transcribeUsdPerMinute: config.usage.transcribeUsdPerMinute,
      pollyEngine: config.aws.pollyEngine,
      pollyUsdPerMillionCharacters: config.usage.pollyUsdPerMillionCharacters,
    }),
    clock,
    timeZone: config.assistant.timeZone,
    dailyBudgetUsd: config.usage.dailyBudgetUsd,
    pollyEngine: config.aws.pollyEngine,
    logger,
  });
  await usage.load(config.discord.guildId);
  const privacy = new PrivacyService(storage.settings);

  logger.info(`Reaching Claude through ${describeClaudeAccess(config.claude.access)}.`);
  const claude = await createClaudeClient(config.claude.access);
  if (options.verifyClaude) {
    await verifyClaudeAccess(claude, config.claude.access, [config.claude.chat.model, config.claude.voice.model], logger);
  }
  const memory = await connectMemoryTools({ transcripts: storage.transcripts, conversations: storage.conversations, memories: storage.memories });

  return {
    config,
    logger,
    clock,
    storage,
    usage,
    privacy,
    claude,
    memory,
    assistant(tools) {
      return new Assistant({
        messages: claude.beta.messages,
        conversations: storage.conversations,
        settings: storage.settings,
        tools: new ToolRegistry([memory.provider, ...tools]),
        logger,
        clock,
        assistantName: config.assistant.name,
        timeZone: config.assistant.timeZone,
        routes: buildRoutes(config),
        memories: storage.memories,
        usage,
        budget: usage,
      });
    },
    async close() {
      await memory.close().catch((error: unknown) => logger.warn(`Closing memory MCP: ${describeError(error)}`));
      await usage.flush();
      await storage.close();
    },
  };
}

/** Every slash command and component handler, in /help order. */
export function allCommands(): { commands: BotCommand[]; components: ComponentHandler[] } {
  return {
    commands: [
      chatCommand,
      customizeCommand,
      resetCommand,
      memoriesCommand,
      privacyCommand,
      usageCommand,
      helpCommand,
      joinCommand,
      leaveCommand,
      playCommand,
      skipCommand,
      stopCommand,
      queueCommand,
      pauseCommand,
      resumeCommand,
    ],
    components: [resetButtons, memoriesComponents],
  };
}
