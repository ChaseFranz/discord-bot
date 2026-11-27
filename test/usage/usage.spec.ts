import { PriceBook } from '../../src/usage/pricing.js';
import { UsageService, claudeUsageFrom, type ClaudeUsageCounts } from '../../src/usage/UsageService.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/sqlite/database.js';
import { SqliteUsageRepository } from '../../src/storage/sqlite/SqliteUsageRepository.js';
import { fakeClock, silentLogger } from '../helpers.js';

const NY = 'America/New_York';
// Thursday 26 November 2026, 2:00 PM in New York.
const START = Date.UTC(2026, 10, 26, 19, 0, 0);

const counts = (overrides: Partial<ClaudeUsageCounts> = {}): ClaudeUsageCounts => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, webSearchRequests: 0, ...overrides,
});

describe('pricing', () => {
  const prices = new PriceBook({ pollyEngine: 'generative' });

  it('prices Claude models, including dated ids and Haiku long prompts', () => {
    expect(prices.claudeRates('claude-opus-5-5', 10_000)).toEqual({ input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 });
    expect(prices.claudeRates('claude-opus-5-5-20261101', 10_000).input).toBe(4);
    expect(prices.claudeRates('claude-opus-5', 10_000).input).toBe(5);
    expect(prices.claudeRates('claude-haiku-5-5', 100_000).input).toBe(0.1);
    expect(prices.claudeRates('claude-haiku-5-5', 100_001)).toEqual({ input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 });
    // Unknown models are charged the highest listed rates, to stay on the safe side.
    expect(prices.isKnownModel('claude-future-9')).toBe(false);
    expect(prices.claudeRates('claude-future-9', 1).output).toBe(50);
  });

  it('prices AWS from list prices, with overrides', () => {
    expect(prices.transcribeUsdPerSecond).toBeCloseTo(0.01 / 60);
    expect(prices.pollyUsdPerCharacter).toBeCloseTo(30 / 1_000_000);
    expect(new PriceBook({ pollyEngine: 'neural' }).pollyUsdPerCharacter).toBeCloseTo(16 / 1_000_000);
    const custom = new PriceBook({ pollyEngine: 'neural', pollyUsdPerMillionCharacters: 19.2, transcribeUsdPerMinute: 0.03 });
    expect(custom.pollyUsdPerCharacter).toBeCloseTo(19.2 / 1_000_000);
    expect(custom.transcribeUsdPerSecond).toBeCloseTo(0.0005);
  });

  it('reads usage objects from the API', () => {
    expect(claudeUsageFrom({ input_tokens: 5, output_tokens: 7, cache_read_input_tokens: null, cache_creation_input_tokens: 40 })).toEqual(
      counts({ inputTokens: 5, outputTokens: 7, cacheWrite5mTokens: 40 }),
    );
    expect(
      claudeUsageFrom({
        input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 9,
        cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 }, server_tool_use: { web_search_requests: 2 },
      }),
    ).toEqual(counts({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWrite5mTokens: 4, cacheWrite1hTokens: 5, webSearchRequests: 2 }));
  });
});

describe('UsageService', () => {
  let db: SqliteDatabase;
  let repository: SqliteUsageRepository;
  let clock: ReturnType<typeof fakeClock>;
  let thresholds: string[];

  const make = (dailyBudgetUsd = 5) => {
    const service = new UsageService({
      repository, prices: new PriceBook({ pollyEngine: 'generative' }), clock, timeZone: NY, dailyBudgetUsd, pollyEngine: 'generative',
      logger: silentLogger(),
    });
    service.onThreshold((guildId, state) => thresholds.push(`${guildId}:${state}`));
    return service;
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    repository = new SqliteUsageRepository(db);
    clock = fakeClock(START);
    thresholds = [];
  });
  afterEach(() => db.close());

  it('adds up what each kind of usage costs and reports it', async () => {
    const usage = make();
    usage.recordClaude('g', 'claude-opus-5-5', counts({ inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 10_000, cacheWrite5mTokens: 2_000, webSearchRequests: 2 }));
    usage.recordClaude('g', 'claude-haiku-5-5', counts({ inputTokens: 2_000, outputTokens: 1_000 }));
    usage.recordTranscription('g', 90);
    usage.recordSpeech('g', 1_000);
    usage.recordClaude('other', 'claude-opus-5-5', counts({ outputTokens: 1_000_000 }));

    // Opus: 0.004 + 0.01 + 0.002 + 0.01 = 0.026; searches 0.02; Haiku 0.0002 + 0.0005; Transcribe 0.015; Polly 0.03.
    const expected = 0.026 + 0.02 + 0.0007 + 0.015 + 0.03;
    expect(usage.status('g')).toMatchObject({ day: '2026-11-26', budgetUsd: 5, state: 'ok' });
    expect(usage.status('g').spentUsd).toBeCloseTo(expected, 6);

    const report = await usage.report('g');
    expect(report.claude.map((m) => m.model)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
    expect(report.claude[0]).toMatchObject({ requests: 1, inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 10_000, cacheWriteTokens: 2_000 });
    expect(report.claude[0]!.costUsd).toBeCloseTo(0.026, 6);
    expect(report.webSearch).toEqual({ requests: 2, costUsd: 0.02 });
    expect(report.transcription.seconds).toBe(90);
    expect(report.speech.characters).toBe(1_000);
    expect(report.week).toHaveLength(1);
    expect(report.week[0]!.costUsd).toBeCloseTo(expected, 6);
  });

  it('warns near the cap, pauses at it once, and resets at local midnight', async () => {
    const usage = make(1);
    usage.recordClaude('g', 'claude-opus-5-5', counts({ outputTokens: 40_000 })); // $0.80
    expect(usage.status('g').state).toBe('warning');
    usage.recordClaude('g', 'claude-opus-5-5', counts({ outputTokens: 15_000 })); // $1.10
    expect(usage.isPaused('g')).toBe(true);
    usage.recordClaude('g', 'claude-opus-5-5', counts({ outputTokens: 100 }));
    expect(thresholds).toEqual(['g:warning', 'g:paused']);
    expect(usage.status('g').resetsAt).toBe(Date.UTC(2026, 10, 27, 5, 0, 0)); // midnight in New York

    clock.set(Date.UTC(2026, 10, 27, 5, 0, 1));
    expect(usage.isPaused('g')).toBe(false);
    expect(usage.status('g')).toMatchObject({ day: '2026-11-27', spentUsd: 0, state: 'ok' });
    // A big jump straight past the cap reports only the cap.
    usage.recordClaude('g', 'claude-opus-5-5', counts({ outputTokens: 60_000 }));
    expect(thresholds.at(-1)).toBe('g:paused');
    expect(thresholds.filter((t) => t === 'g:warning')).toHaveLength(1);
  });

  it("picks up today's spending after a restart without announcing again", async () => {
    const before = make(1);
    before.recordClaude('g', 'claude-opus-5-5', counts({ outputTokens: 60_000 }));
    await before.flush();
    thresholds = [];

    const after = make(1);
    await after.load('g');
    expect(after.isPaused('g')).toBe(true);
    after.recordClaude('g', 'claude-opus-5-5', counts({ outputTokens: 100 }));
    expect(thresholds).toEqual([]);
  });

  it('only tracks when there is no cap', () => {
    const usage = make(0);
    usage.recordClaude('g', 'claude-opus-5-5', counts({ outputTokens: 10_000_000 }));
    expect(usage.status('g')).toMatchObject({ budgetUsd: null, state: 'ok' });
    expect(usage.isPaused('g')).toBe(false);
  });
});
