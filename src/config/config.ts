import { z } from 'zod';

/** Thinking-depth levels accepted by `output_config.effort` on current Claude models. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const POLLY_ENGINES = ['standard', 'neural', 'long-form', 'generative'] as const;
export type PollyEngine = (typeof POLLY_ENGINES)[number];

/**
 * How the bot reaches Claude.
 *  - aws: Claude Platform on AWS - Anthropic's Claude API, signed with AWS credentials (SigV4)
 *         and billed through AWS Marketplace.
 *  - anthropic: the Claude API directly, with an Anthropic API key.
 */
export const CLAUDE_PROVIDERS = ['aws', 'anthropic'] as const;
export type ClaudeProvider = (typeof CLAUDE_PROVIDERS)[number];

const WORKSPACE_ID_PREFIX = 'wrkspc_';

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string({ error: 'DISCORD_BOT_TOKEN is required' }).min(1),
  CLIENT_ID: z.string({ error: 'CLIENT_ID is required' }).min(1),
  GUILD_ID: z.string({ error: 'GUILD_ID is required' }).min(1),

  CLAUDE_PROVIDER: z.enum(CLAUDE_PROVIDERS).default('aws'),
  ANTHROPIC_AWS_WORKSPACE_ID: z
    .string()
    .startsWith(WORKSPACE_ID_PREFIX, `must be a Claude Platform on AWS workspace ID (it starts with "${WORKSPACE_ID_PREFIX}")`)
    .optional(),
  CLAUDE_AWS_REGION: z.string().optional(),
  CLAUDE_CHAT_MODEL: z.string().default('claude-opus-5-5'),
  CLAUDE_VOICE_MODEL: z.string().default('claude-haiku-5-5'),
  CLAUDE_CHAT_EFFORT: z.enum(EFFORT_LEVELS).default('medium'),
  CLAUDE_VOICE_EFFORT: z.enum(EFFORT_LEVELS).default('low'),
  WEB_SEARCH_ENABLED: z.stringbool().default(true),

  AWS_REGION: z.string({ error: 'AWS_REGION is required (used by Transcribe, Polly and Claude Platform on AWS)' }).min(1),
  TRANSCRIBE_LANGUAGE_CODE: z.string().default('en-US'),
  POLLY_VOICE_ID: z.string().default('Joanna'),
  POLLY_ENGINE: z.enum(POLLY_ENGINES).default('generative'),

  ASSISTANT_NAME: z.string().default('Nimbus'),
  WAKE_WORD: z.string().optional(),
  WAKE_SOUND_ENABLED: z.stringbool().default(true),
  AMBIENT_CONTEXT_MINUTES: z.coerce.number().min(0).max(60).default(3),
  FOLLOW_UP_SECONDS: z.coerce.number().min(0).max(60).default(8),
  AUTO_LEAVE_MINUTES: z.coerce.number().min(0).max(24 * 60).default(2),
  TIMEZONE: z.string().optional(),

  DAILY_BUDGET_USD: z.coerce.number().min(0).default(5),
  TRANSCRIBE_USD_PER_MINUTE: z.coerce.number().min(0).optional(),
  POLLY_USD_PER_MILLION_CHARACTERS: z.coerce.number().min(0).optional(),

  DATABASE_PATH: z.string().default('./data/bot.db'),
  MEMORY_DATABASE_PATH: z.string().default('./data/memories.db'),
  MEMORY_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),

  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
});

export interface ClaudeRouteConfig {
  model: string;
  effort: Effort;
}

/** Where Claude requests go, with what each provider needs. */
export type ClaudeAccess =
  | {
      provider: 'aws';
      /** Region the Claude Platform on AWS workspace is bound to (workspaces are region-scoped). */
      region: string;
      workspaceId: string;
    }
  | { provider: 'anthropic' };

export interface AppConfig {
  discord: {
    token: string;
    clientId: string;
    guildId: string;
  };
  claude: {
    access: ClaudeAccess;
    chat: ClaudeRouteConfig;
    voice: ClaudeRouteConfig;
    webSearchEnabled: boolean;
  };
  aws: {
    region: string;
    transcribeLanguageCode: string;
    pollyVoiceId: string;
    pollyEngine: PollyEngine;
  };
  assistant: {
    name: string;
    wakeWord: string;
    /** Play a chime when the assistant hears its name. */
    wakeSound: boolean;
    ambientContextMinutes: number;
    /** How long after a spoken reply the same person can carry on without the wake word (0 = off). */
    followUpSeconds: number;
    /** Leave a voice channel after it has been empty this long (0 = stay). */
    autoLeaveMinutes: number;
    timeZone: string;
  };
  usage: {
    /** Daily spending cap per server in USD (0 = track spending without a cap). */
    dailyBudgetUsd: number;
    /** Price overrides for regions or plans that differ from the built-in us-east-1 list prices. */
    transcribeUsdPerMinute: number | undefined;
    pollyUsdPerMillionCharacters: number | undefined;
  };
  storage: {
    databasePath: string;
    /** Long-term notes about people, kept in their own database. */
    memoryDatabasePath: string;
    retentionDays: number;
  };
  logLevel: 'error' | 'warn' | 'info' | 'debug';
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Reads and validates configuration from environment variables.
 * Empty strings are treated as unset so a blank line in `.env` falls back to the default.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const cleaned = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value === undefined || value.trim() === '' ? undefined : value.trim()]),
  );
  const parsed = envSchema.safeParse(cleaned);
  const problems = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  // Cross-field rule, checked alongside the others so every problem is reported at once.
  if ((cleaned.CLAUDE_PROVIDER ?? 'aws') === 'aws' && !cleaned.ANTHROPIC_AWS_WORKSPACE_ID) {
    problems.push(
      '  - ANTHROPIC_AWS_WORKSPACE_ID: required for Claude Platform on AWS (CLAUDE_PROVIDER=aws, the default). ' +
        'Find it under Workspaces on the Claude Platform on AWS page in the AWS Console, ' +
        'or set CLAUDE_PROVIDER=anthropic to use the Claude API directly with ANTHROPIC_API_KEY.',
    );
  }
  if (!parsed.success || problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n${problems.join('\n')}`);
  }
  const e = parsed.data;

  const access: ClaudeAccess =
    e.CLAUDE_PROVIDER === 'aws'
      ? { provider: 'aws', region: e.CLAUDE_AWS_REGION ?? e.AWS_REGION, workspaceId: e.ANTHROPIC_AWS_WORKSPACE_ID! }
      : { provider: 'anthropic' };

  const timeZone = e.TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!isValidTimeZone(timeZone)) {
    throw new ConfigError(`Invalid configuration:\n  - TIMEZONE: "${timeZone}" is not a recognised IANA time zone`);
  }

  return {
    discord: { token: e.DISCORD_BOT_TOKEN, clientId: e.CLIENT_ID, guildId: e.GUILD_ID },
    claude: {
      access,
      chat: { model: e.CLAUDE_CHAT_MODEL, effort: e.CLAUDE_CHAT_EFFORT },
      voice: { model: e.CLAUDE_VOICE_MODEL, effort: e.CLAUDE_VOICE_EFFORT },
      webSearchEnabled: e.WEB_SEARCH_ENABLED,
    },
    aws: {
      region: e.AWS_REGION,
      transcribeLanguageCode: e.TRANSCRIBE_LANGUAGE_CODE,
      pollyVoiceId: e.POLLY_VOICE_ID,
      pollyEngine: e.POLLY_ENGINE,
    },
    assistant: {
      name: e.ASSISTANT_NAME,
      wakeWord: (e.WAKE_WORD ?? e.ASSISTANT_NAME).toLowerCase(),
      wakeSound: e.WAKE_SOUND_ENABLED,
      ambientContextMinutes: e.AMBIENT_CONTEXT_MINUTES,
      followUpSeconds: e.FOLLOW_UP_SECONDS,
      autoLeaveMinutes: e.AUTO_LEAVE_MINUTES,
      timeZone,
    },
    usage: {
      dailyBudgetUsd: e.DAILY_BUDGET_USD,
      transcribeUsdPerMinute: e.TRANSCRIBE_USD_PER_MINUTE,
      pollyUsdPerMillionCharacters: e.POLLY_USD_PER_MILLION_CHARACTERS,
    },
    storage: { databasePath: e.DATABASE_PATH, memoryDatabasePath: e.MEMORY_DATABASE_PATH, retentionDays: e.MEMORY_RETENTION_DAYS },
    logLevel: e.LOG_LEVEL,
  };
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
