import { ConfigError, loadConfig } from '../src/config/config.js';

const required = {
  DISCORD_BOT_TOKEN: 'token',
  CLIENT_ID: 'client',
  GUILD_ID: 'guild',
  AWS_REGION: 'us-east-1',
  ANTHROPIC_AWS_WORKSPACE_ID: 'wrkspc_01Test',
};

describe('loadConfig', () => {
  it('reaches Claude through Claude Platform on AWS by default, in the AWS region', () => {
    expect(loadConfig({ ...required }).claude.access).toEqual({ provider: 'aws', region: 'us-east-1', workspaceId: 'wrkspc_01Test' });
    expect(loadConfig({ ...required, CLAUDE_AWS_REGION: 'us-west-2' }).claude.access).toMatchObject({ region: 'us-west-2' });
  });

  it('requires a workspace ID for Claude Platform on AWS, and only then', () => {
    const { ANTHROPIC_AWS_WORKSPACE_ID: _omit, ...withoutWorkspace } = required;
    expect(() => loadConfig(withoutWorkspace)).toThrow(/ANTHROPIC_AWS_WORKSPACE_ID: required for Claude Platform on AWS/);
    expect(() => loadConfig({ ...required, ANTHROPIC_AWS_WORKSPACE_ID: 'my-workspace' })).toThrow(/starts with "wrkspc_"/);
    expect(loadConfig({ ...withoutWorkspace, CLAUDE_PROVIDER: 'anthropic' }).claude.access).toEqual({ provider: 'anthropic' });
    expect(() => loadConfig({ ...required, CLAUDE_PROVIDER: 'bedrock' })).toThrow(/CLAUDE_PROVIDER/);
  });

  it('applies defaults: Opus for text, Haiku for voice, explicit effort levels', () => {
    const config = loadConfig({ ...required });
    expect(config.claude.chat).toEqual({ model: 'claude-opus-5-5', effort: 'medium' });
    expect(config.claude.voice).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(config.claude.webSearchEnabled).toBe(true);
    expect(config.assistant.name).toBe('Nimbus');
    expect(config.assistant.wakeWord).toBe('nimbus');
    expect(config.assistant.wakeSound).toBe(true);
    expect(config.storage).toEqual({
      backend: { kind: 'sqlite', databasePath: './data/bot.db', memoryDatabasePath: './data/memories.db' },
      retentionDays: 30,
    });
    expect(config.aws).toEqual({
      region: 'us-east-1',
      transcribeLanguageCode: 'en-US',
      pollyVoiceId: 'Kenneth',
      pollyEngine: 'generative',
      pollyStreaming: true,
    });
    expect(loadConfig({ ...required, POLLY_STREAMING: 'false' }).aws.pollyStreaming).toBe(false);
    expect(config.music).toEqual({ enabled: true, source: 'direct', ytDlpPath: 'yt-dlp', helpers: undefined });
    expect(loadConfig({ ...required, MUSIC_ENABLED: 'false' }).music.enabled).toBe(false);
    expect(loadConfig({ ...required, YT_DLP_PATH: '/opt/bin/yt-dlp' }).music.ytDlpPath).toBe('/opt/bin/yt-dlp');
  });

  it('treats blank values as unset', () => {
    const config = loadConfig({ ...required, CLAUDE_CHAT_MODEL: '   ', MEMORY_RETENTION_DAYS: '', YT_DLP_PATH: ' ' });
    expect(config.claude.chat.model).toBe('claude-opus-5-5');
    expect(config.storage.retentionDays).toBe(30);
    expect(config.music.ytDlpPath).toBe('yt-dlp');
  });

  it('derives the wake word from the assistant name unless set', () => {
    expect(loadConfig({ ...required, ASSISTANT_NAME: 'Friday' }).assistant.wakeWord).toBe('friday');
    expect(loadConfig({ ...required, ASSISTANT_NAME: 'Friday', WAKE_WORD: 'Computer' }).assistant.wakeWord).toBe('computer');
  });

  it('parses booleans and numbers', () => {
    const config = loadConfig({ ...required, WEB_SEARCH_ENABLED: 'false', WAKE_SOUND_ENABLED: 'false', MEMORY_RETENTION_DAYS: '0' });
    expect(config.claude.webSearchEnabled).toBe(false);
    expect(config.assistant.wakeSound).toBe(false);
    expect(config.storage.retentionDays).toBe(0);
  });

  it('lists every missing or invalid setting at once', () => {
    expect.assertions(5);
    try {
      loadConfig({ CLAUDE_VOICE_EFFORT: 'turbo' });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toContain('DISCORD_BOT_TOKEN');
      expect(message).toContain('AWS_REGION');
      expect(message).toContain('CLAUDE_VOICE_EFFORT');
      expect(message).toContain('ANTHROPIC_AWS_WORKSPACE_ID');
    }
  });

  it('rejects an unknown time zone', () => {
    expect(() => loadConfig({ ...required, TIMEZONE: 'Mars/Olympus' })).toThrow(ConfigError);
  });

  it('defaults follow-up mode, auto-leave and the $5 daily budget, and validates them', () => {
    const config = loadConfig({ ...required });
    expect(config.assistant).toMatchObject({ followUpSeconds: 8, autoLeaveMinutes: 2 });
    expect(config.usage).toEqual({ dailyBudgetUsd: 5, transcribeUsdPerMinute: undefined, pollyUsdPerMillionCharacters: undefined });
    const custom = loadConfig({
      ...required, FOLLOW_UP_SECONDS: '0', AUTO_LEAVE_MINUTES: '10', DAILY_BUDGET_USD: '0', TRANSCRIBE_USD_PER_MINUTE: '0.024',
    });
    expect(custom.assistant).toMatchObject({ followUpSeconds: 0, autoLeaveMinutes: 10 });
    expect(custom.usage).toMatchObject({ dailyBudgetUsd: 0, transcribeUsdPerMinute: 0.024 });
    expect(() => loadConfig({ ...required, DAILY_BUDGET_USD: '-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...required, FOLLOW_UP_SECONDS: 'soon' })).toThrow(/FOLLOW_UP_SECONDS/);
  });

  it('defaults how it takes part in a call, and validates each setting', () => {
    expect(loadConfig({ ...required }).call).toEqual({
      followUps: 'everyone', silenceMs: 600, bargeIn: 'askers', bargeInMs: 500, acknowledge: true, saveTurnsToThreads: true,
    });
    const custom = loadConfig({
      ...required, VOICE_FOLLOW_UPS: 'always', VOICE_SILENCE_MS: '900', VOICE_BARGE_IN: 'off', VOICE_BARGE_IN_MS: '800',
      VOICE_ACKNOWLEDGE: 'false', VOICE_SAVE_TO_THREADS: 'false',
    });
    expect(custom.call).toEqual({
      followUps: 'always', silenceMs: 900, bargeIn: 'off', bargeInMs: 800, acknowledge: false, saveTurnsToThreads: false,
    });
    expect(() => loadConfig({ ...required, VOICE_FOLLOW_UPS: 'nobody' })).toThrow(/VOICE_FOLLOW_UPS/);
    expect(() => loadConfig({ ...required, VOICE_BARGE_IN: 'sometimes' })).toThrow(/VOICE_BARGE_IN/);
    // Too short a silence would cut people off between words.
    expect(() => loadConfig({ ...required, VOICE_SILENCE_MS: '50' })).toThrow(/VOICE_SILENCE_MS/);
    expect(() => loadConfig({ ...required, VOICE_BARGE_IN_MS: '20' })).toThrow(/VOICE_BARGE_IN_MS/);
  });

  it('has music fetched by helpers only with everything that takes in place', () => {
    const helpers = {
      ...required, STORAGE: 'dynamodb', MUSIC_SOURCE: 'helpers',
      MUSIC_HELPER_API_URL: 'https://abc.lambda-url.us-east-1.on.aws/', MUSIC_RELAY_BUCKET: 'nimbus-music-relay',
    };
    expect(loadConfig(helpers).music).toEqual({
      enabled: true, source: 'helpers', ytDlpPath: 'yt-dlp',
      helpers: {
        apiUrl: 'https://abc.lambda-url.us-east-1.on.aws/', relayBucket: 'nimbus-music-relay',
        guideUrl: 'https://github.com/ChaseFranz/discord-bot/tree/main/helper#readme',
      },
    });
    expect(loadConfig({ ...helpers, MUSIC_HELPER_GUIDE_URL: 'https://example.com/helper' }).music.helpers?.guideUrl).toBe('https://example.com/helper');

    expect.assertions(6);
    try {
      loadConfig({ ...required, MUSIC_SOURCE: 'helpers' });
    } catch (error) {
      const message = (error as Error).message;
      expect(error).toBeInstanceOf(ConfigError);
      expect(message).toContain('MUSIC_SOURCE: "helpers" needs STORAGE=dynamodb');
      expect(message).toContain('MUSIC_HELPER_API_URL: required when MUSIC_SOURCE=helpers');
      expect(message).toContain('MUSIC_RELAY_BUCKET: required when MUSIC_SOURCE=helpers');
    }
  });

  it('switches storage to DynamoDB tables', () => {
    expect(loadConfig({ ...required, STORAGE: 'dynamodb' }).storage.backend).toEqual({
      kind: 'dynamodb', region: 'us-east-1', table: 'nimbus', memoryTable: 'nimbus-memories',
    });
    expect(
      loadConfig({ ...required, STORAGE: 'dynamodb', DYNAMODB_TABLE: 'dev', DYNAMODB_ENDPOINT: 'http://localhost:8000' }).storage.backend,
    ).toMatchObject({ table: 'dev', endpoint: 'http://localhost:8000' });
    expect(() => loadConfig({ ...required, STORAGE: 'postgres' })).toThrow(/STORAGE/);
    expect(() => loadConfig({ ...required, DYNAMODB_ENDPOINT: 'not a url' })).toThrow(/DYNAMODB_ENDPOINT/);
  });
});
