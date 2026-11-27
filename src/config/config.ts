import { z } from 'zod';
import type { StorageConfig } from '../storage/open.js';

/** Thinking-depth levels accepted by `output_config.effort` on current Claude models. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const POLLY_ENGINES = ['standard', 'neural', 'long-form', 'generative'] as const;
export type PollyEngine = (typeof POLLY_ENGINES)[number];
/** Who may carry on talking to the assistant in a call without its name. */
export const FOLLOW_UPS = ['askers', 'everyone', 'always'] as const;
export type FollowUps = (typeof FOLLOW_UPS)[number];
/** Whose voice makes the assistant pause mid-reply. */
export const BARGE_IN = ['askers', 'everyone', 'off'] as const;
export type BargeIn = (typeof BARGE_IN)[number];
/** Who fetches music from YouTube: the bot itself, or a helper on someone's own computer. */
export const MUSIC_SOURCES = ['direct', 'helpers'] as const;
export type MusicSource = (typeof MUSIC_SOURCES)[number];

export interface MusicHelperConfig {
  /** The public address music helpers talk to. */
  apiUrl: string;
  /** The S3 bucket the audio is relayed through. */
  relayBucket: string;
  /** Where people download the helper and read how to set it up. */
  guideUrl: string;
}

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
  POLLY_VOICE_ID: z.string().default('Kenneth'),
  POLLY_ENGINE: z.enum(POLLY_ENGINES).default('generative'),
  POLLY_STREAMING: z.stringbool().default(true),

  MUSIC_ENABLED: z.stringbool().default(true),
  MUSIC_SOURCE: z.enum(MUSIC_SOURCES).default('direct'),
  YT_DLP_PATH: z.string().min(1).default('yt-dlp'),
  MUSIC_HELPER_API_URL: z.url().optional(),
  MUSIC_RELAY_BUCKET: z.string().min(3).optional(),
  MUSIC_HELPER_GUIDE_URL: z.url().default('https://github.com/ChaseFranz/discord-bot/tree/main/helper#readme'),

  ASSISTANT_NAME: z.string().default('Nimbus'),
  WAKE_WORD: z.string().optional(),
  WAKE_SOUND_ENABLED: z.stringbool().default(true),
  FOLLOW_UP_SECONDS: z.coerce.number().min(0).max(60).default(8),
  VOICE_FOLLOW_UPS: z.enum(FOLLOW_UPS).default('everyone'),
  VOICE_SILENCE_MS: z.coerce.number().int().min(200).max(3000).default(600),
  VOICE_BARGE_IN: z.enum(BARGE_IN).default('askers'),
  VOICE_BARGE_IN_MS: z.coerce.number().int().min(100).max(5000).default(500),
  VOICE_ACKNOWLEDGE: z.stringbool().default(true),
  VOICE_SAVE_TO_THREADS: z.stringbool().default(true),
  AUTO_LEAVE_MINUTES: z.coerce.number().min(0).max(24 * 60).default(2),
  TIMEZONE: z.string().optional(),

  DAILY_BUDGET_USD: z.coerce.number().min(0).default(5),
  TRANSCRIBE_USD_PER_MINUTE: z.coerce.number().min(0).optional(),
  POLLY_USD_PER_MILLION_CHARACTERS: z.coerce.number().min(0).optional(),

  STORAGE: z.enum(['sqlite', 'dynamodb']).default('sqlite'),
  DATABASE_PATH: z.string().default('./data/bot.db'),
  MEMORY_DATABASE_PATH: z.string().default('./data/memories.db'),
  DYNAMODB_TABLE: z.string().default('nimbus'),
  DYNAMODB_MEMORY_TABLE: z.string().default('nimbus-memories'),
  DYNAMODB_ENDPOINT: z.url().optional(),
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
    /** Speak each reply through one Polly stream, so its sentences flow together (generative engine only). */
    pollyStreaming: boolean;
  };
  music: {
    /** Off: the music commands and Nimbus say music is turned off, and nothing is fetched from YouTube. */
    enabled: boolean;
    /**
     * Who fetches the audio from YouTube: the bot itself ('direct', with yt-dlp), or a music helper
     * running on someone's own computer ('helpers', for where YouTube won't serve the bot).
     */
    source: MusicSource;
    /** The yt-dlp executable that fetches YouTube audio: a path, or a name on PATH. */
    ytDlpPath: string;
    /** Set when `source` is 'helpers'. */
    helpers: MusicHelperConfig | undefined;
  };
  assistant: {
    name: string;
    wakeWord: string;
    /** Play a chime when the assistant hears its name. */
    wakeSound: boolean;
    /** How long after a spoken reply people can carry on without the wake word (0 = off). */
    followUpSeconds: number;
    /** Leave a voice channel after it has been empty this long (0 = stay). */
    autoLeaveMinutes: number;
    timeZone: string;
  };
  /** How the assistant takes part in a call. */
  call: {
    /** Who may carry on without the wake word: the people just answered, everyone, or always everyone. */
    followUps: FollowUps;
    /** How long someone must be quiet before what they said counts as finished. */
    silenceMs: number;
    /** Whose voice makes the assistant pause mid-reply. */
    bargeIn: BargeIn;
    /** How much they must say before it pauses (shorter sounds are ignored). */
    bargeInMs: number;
    /** Tell someone "one sec" when they ask for something while a reply to someone else is playing. */
    acknowledge: boolean;
    /** Also keep what each person asked in a call, and the reply, in their own typed thread. */
    saveTurnsToThreads: boolean;
  };
  usage: {
    /** Daily spending cap per server in USD (0 = track spending without a cap). */
    dailyBudgetUsd: number;
    /** Price overrides for regions or plans that differ from the built-in us-east-1 list prices. */
    transcribeUsdPerMinute: number | undefined;
    pollyUsdPerMillionCharacters: number | undefined;
  };
  storage: {
    /** SQLite files on this computer, or DynamoDB tables (long-term notes in their own in both). */
    backend: StorageConfig;
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
  if (cleaned.MUSIC_SOURCE === 'helpers') {
    // Helpers are coordinated through the AWS deployment's table, bucket and public address.
    if (cleaned.STORAGE !== 'dynamodb') problems.push('  - MUSIC_SOURCE: "helpers" needs STORAGE=dynamodb (it is for the bot on AWS; on a PC use "direct").');
    if (!cleaned.MUSIC_HELPER_API_URL) problems.push('  - MUSIC_HELPER_API_URL: required when MUSIC_SOURCE=helpers (the CDK stack sets it).');
    if (!cleaned.MUSIC_RELAY_BUCKET) problems.push('  - MUSIC_RELAY_BUCKET: required when MUSIC_SOURCE=helpers (the CDK stack sets it).');
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
      pollyStreaming: e.POLLY_STREAMING,
    },
    music: {
      enabled: e.MUSIC_ENABLED,
      source: e.MUSIC_SOURCE,
      ytDlpPath: e.YT_DLP_PATH,
      helpers:
        e.MUSIC_SOURCE === 'helpers'
          ? { apiUrl: e.MUSIC_HELPER_API_URL!, relayBucket: e.MUSIC_RELAY_BUCKET!, guideUrl: e.MUSIC_HELPER_GUIDE_URL }
          : undefined,
    },
    assistant: {
      name: e.ASSISTANT_NAME,
      wakeWord: (e.WAKE_WORD ?? e.ASSISTANT_NAME).toLowerCase(),
      wakeSound: e.WAKE_SOUND_ENABLED,
      followUpSeconds: e.FOLLOW_UP_SECONDS,
      autoLeaveMinutes: e.AUTO_LEAVE_MINUTES,
      timeZone,
    },
    call: {
      followUps: e.VOICE_FOLLOW_UPS,
      silenceMs: e.VOICE_SILENCE_MS,
      bargeIn: e.VOICE_BARGE_IN,
      bargeInMs: e.VOICE_BARGE_IN_MS,
      acknowledge: e.VOICE_ACKNOWLEDGE,
      saveTurnsToThreads: e.VOICE_SAVE_TO_THREADS,
    },
    usage: {
      dailyBudgetUsd: e.DAILY_BUDGET_USD,
      transcribeUsdPerMinute: e.TRANSCRIBE_USD_PER_MINUTE,
      pollyUsdPerMillionCharacters: e.POLLY_USD_PER_MILLION_CHARACTERS,
    },
    storage: {
      backend:
        e.STORAGE === 'dynamodb'
          ? {
              kind: 'dynamodb',
              region: e.AWS_REGION,
              table: e.DYNAMODB_TABLE,
              memoryTable: e.DYNAMODB_MEMORY_TABLE,
              ...(e.DYNAMODB_ENDPOINT ? { endpoint: e.DYNAMODB_ENDPOINT } : {}),
            }
          : { kind: 'sqlite', databasePath: e.DATABASE_PATH, memoryDatabasePath: e.MEMORY_DATABASE_PATH },
      retentionDays: e.MEMORY_RETENTION_DAYS,
    },
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
