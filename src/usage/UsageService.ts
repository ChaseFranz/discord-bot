import type { Logger } from '../logging/logger.js';
import { describeError } from '../logging/logger.js';
import type { UsageLine, UsageRepository } from '../storage/ports.js';
import type { Clock } from '../util/time.js';
import { localDayKey, shiftDayKey, startOfNextLocalDay } from '../util/zonedTime.js';
import type { PriceBook } from './pricing.js';

/** Token counts from one Claude response (`message.usage`). */
export interface ClaudeUsageCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  webSearchRequests: number;
}

/** The fields of the API's usage object this module reads. */
export interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
  server_tool_use?: { web_search_requests: number } | null;
}

export function claudeUsageFrom(usage: ApiUsage): ClaudeUsageCounts {
  const breakdown = usage.cache_creation;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    // Without a TTL breakdown, every cache write is the default 5-minute kind.
    cacheWrite5mTokens: breakdown ? breakdown.ephemeral_5m_input_tokens : (usage.cache_creation_input_tokens ?? 0),
    cacheWrite1hTokens: breakdown ? breakdown.ephemeral_1h_input_tokens : 0,
    webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
  };
}

/** What code that spends money reports. */
export interface UsageMeter {
  recordClaude(guildId: string, model: string, usage: ClaudeUsageCounts): void;
  /** Seconds of audio streamed to speech-to-text. */
  recordTranscription(guildId: string, seconds: number): void;
  /** Characters sent to text-to-speech. */
  recordSpeech(guildId: string, characters: number): void;
}

/** What code that is about to spend money checks. */
export interface BudgetGate {
  /** True once today's spending has reached the daily budget; stays true until local midnight. */
  isPaused(guildId: string): boolean;
}

export type BudgetState = 'ok' | 'warning' | 'paused';

export interface BudgetStatus {
  /** Local day, YYYY-MM-DD. */
  day: string;
  spentUsd: number;
  /** Null when there is no cap. */
  budgetUsd: number | null;
  state: BudgetState;
  /** When spending resets (the next local midnight). */
  resetsAt: number;
}

export interface ClaudeModelUsage {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface UsageReport {
  status: BudgetStatus;
  claude: ClaudeModelUsage[];
  webSearch: { requests: number; costUsd: number };
  transcription: { seconds: number; costUsd: number };
  speech: { characters: number; costUsd: number };
  /** The last seven local days, today included, oldest first. */
  week: Array<{ day: string; costUsd: number }>;
}

export interface UsageServiceDeps {
  repository: UsageRepository;
  prices: PriceBook;
  clock: Clock;
  timeZone: string;
  /** Daily spending cap per server in USD; 0 means track only. */
  dailyBudgetUsd: number;
  /** Polly engine name, used to label speech usage. */
  pollyEngine: string;
  logger: Logger;
  /** Fraction of the budget at which the state turns to 'warning'. */
  warningFraction?: number;
}

interface DayTotals {
  day: string;
  spentUsd: number;
  /** Threshold states already reported for this day, so each is reported once. */
  reported: Set<BudgetState>;
}

const MILLION = 1_000_000;

/**
 * Meters spending per server and local day, persists it, and enforces the daily budget. Totals for
 * today are kept in memory (this process is the only writer), so checks are synchronous.
 */
export class UsageService implements UsageMeter, BudgetGate {
  private readonly days = new Map<string, DayTotals>();
  private readonly listeners: Array<(guildId: string, state: Exclude<BudgetState, 'ok'>) => void> = [];
  private readonly warnedModels = new Set<string>();
  private readonly warningFraction: number;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly deps: UsageServiceDeps) {
    this.warningFraction = deps.warningFraction ?? 0.8;
  }

  /** Loads today's spending so far (call at startup for each server the bot serves). */
  async load(guildId: string): Promise<void> {
    const day = this.today();
    const lines = await this.deps.repository.day(guildId, day);
    const totals: DayTotals = { day, spentUsd: lines.reduce((sum, line) => sum + line.costUsd, 0), reported: new Set() };
    // Thresholds crossed before a restart were already announced.
    const state = this.stateFor(totals.spentUsd);
    if (state === 'warning') totals.reported.add('warning');
    if (state === 'paused') totals.reported.add('warning').add('paused');
    this.days.set(guildId, totals);
  }

  /** Called once each time a server reaches the warning level or the cap. */
  onThreshold(listener: (guildId: string, state: Exclude<BudgetState, 'ok'>) => void): void {
    this.listeners.push(listener);
  }

  recordClaude(guildId: string, model: string, usage: ClaudeUsageCounts): void {
    const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
    if (!this.deps.prices.isKnownModel(model) && !this.warnedModels.has(model)) {
      this.warnedModels.add(model);
      this.deps.logger.warn(`No price listed for ${model}; estimating its cost at the highest Claude rates.`);
    }
    const r = this.deps.prices.claudeRates(model, prompt);
    const metric = (name: string) => `claude.${model}.${name}`;
    this.record(guildId, [
      { metric: metric('requests'), quantity: 1, costUsd: 0 },
      { metric: metric('input_tokens'), quantity: usage.inputTokens, costUsd: (usage.inputTokens * r.input) / MILLION },
      { metric: metric('output_tokens'), quantity: usage.outputTokens, costUsd: (usage.outputTokens * r.output) / MILLION },
      { metric: metric('cache_read_tokens'), quantity: usage.cacheReadTokens, costUsd: (usage.cacheReadTokens * r.cacheRead) / MILLION },
      {
        metric: metric('cache_write_5m_tokens'),
        quantity: usage.cacheWrite5mTokens,
        costUsd: (usage.cacheWrite5mTokens * r.cacheWrite5m) / MILLION,
      },
      {
        metric: metric('cache_write_1h_tokens'),
        quantity: usage.cacheWrite1hTokens,
        costUsd: (usage.cacheWrite1hTokens * r.cacheWrite1h) / MILLION,
      },
      ...(usage.webSearchRequests > 0
        ? [{ metric: 'web_search.requests', quantity: usage.webSearchRequests, costUsd: usage.webSearchRequests * this.deps.prices.webSearchUsd }]
        : []),
    ].filter((line) => line.quantity > 0));
  }

  recordTranscription(guildId: string, seconds: number): void {
    if (seconds <= 0) return;
    this.record(guildId, [{ metric: 'transcribe.seconds', quantity: seconds, costUsd: seconds * this.deps.prices.transcribeUsdPerSecond }]);
  }

  recordSpeech(guildId: string, characters: number): void {
    if (characters <= 0) return;
    this.record(guildId, [
      { metric: `polly.${this.deps.pollyEngine}.characters`, quantity: characters, costUsd: characters * this.deps.prices.pollyUsdPerCharacter },
    ]);
  }

  isPaused(guildId: string): boolean {
    // Checked every time someone starts talking, so skip the rest of status().
    return this.stateFor(this.totals(guildId).spentUsd) === 'paused';
  }

  status(guildId: string): BudgetStatus {
    const now = this.deps.clock();
    const totals = this.totals(guildId);
    return {
      day: totals.day,
      spentUsd: totals.spentUsd,
      budgetUsd: this.deps.dailyBudgetUsd > 0 ? this.deps.dailyBudgetUsd : null,
      state: this.stateFor(totals.spentUsd),
      resetsAt: startOfNextLocalDay(now, this.deps.timeZone),
    };
  }

  /** Today's usage broken down, plus the last week's daily totals (for /usage). */
  async report(guildId: string): Promise<UsageReport> {
    await this.flush();
    const status = this.status(guildId);
    const [lines, week] = await Promise.all([
      this.deps.repository.day(guildId, status.day),
      this.deps.repository.dailyTotals(guildId, shiftDayKey(status.day, -6), status.day),
    ]);
    return { status, ...summarize(lines), week };
  }

  /** Resolves once everything recorded so far has been written. */
  flush(): Promise<void> {
    return this.writes;
  }

  /**
   * Picks up spending recorded by other processes (on AWS, Lambda and the voice task both spend),
   * reporting the warning or the cap if that crosses one.
   */
  async refresh(guildId: string): Promise<void> {
    await this.flush();
    const totals = this.totals(guildId);
    const before = this.stateFor(totals.spentUsd);
    const stored = await this.deps.repository.dayTotal(guildId, totals.day);
    // Never below what this process knows it spent (in case a write failed).
    totals.spentUsd = Math.max(totals.spentUsd, stored);
    this.reportCrossing(guildId, totals, before);
  }

  private record(guildId: string, lines: UsageLine[]): void {
    if (lines.length === 0) return;
    const totals = this.totals(guildId);
    const before = this.stateFor(totals.spentUsd);
    totals.spentUsd += lines.reduce((sum, line) => sum + line.costUsd, 0);
    const day = totals.day;
    this.writes = this.writes
      .then(() => this.deps.repository.add(guildId, day, lines))
      .catch((error: unknown) => {
        this.deps.logger.warn(`Could not save usage: ${describeError(error)}`);
      });
    this.reportCrossing(guildId, totals, before);
  }

  private reportCrossing(guildId: string, totals: DayTotals, before: BudgetState): void {
    const after = this.stateFor(totals.spentUsd);
    if (after === before || after === 'ok' || totals.reported.has(after)) return;
    // Report each level once per day. Jumping straight to the cap reports only the cap.
    totals.reported.add(after);
    if (after === 'paused') totals.reported.add('warning');
    this.deps.logger.warn(
      after === 'paused'
        ? `Daily budget of $${this.deps.dailyBudgetUsd.toFixed(2)} reached in guild ${guildId} ($${totals.spentUsd.toFixed(2)} spent); pausing until midnight.`
        : `Guild ${guildId} has used ${Math.round(this.warningFraction * 100)}% of today's $${this.deps.dailyBudgetUsd.toFixed(2)} budget.`,
    );
    for (const listener of this.listeners) {
      try {
        listener(guildId, after);
      } catch (error) {
        this.deps.logger.warn(`Budget listener failed: ${describeError(error)}`);
      }
    }
  }

  private totals(guildId: string): DayTotals {
    const day = this.today();
    let totals = this.days.get(guildId);
    if (!totals || totals.day !== day) {
      // A new local day (or a server seen for the first time today): spending starts from zero.
      totals = { day, spentUsd: 0, reported: new Set() };
      this.days.set(guildId, totals);
    }
    return totals;
  }

  private stateFor(spentUsd: number): BudgetState {
    const budget = this.deps.dailyBudgetUsd;
    if (budget <= 0) return 'ok';
    if (spentUsd >= budget) return 'paused';
    if (spentUsd >= budget * this.warningFraction) return 'warning';
    return 'ok';
  }

  private today(): string {
    return localDayKey(this.deps.clock(), this.deps.timeZone);
  }
}

function summarize(lines: readonly UsageLine[]): Omit<UsageReport, 'status' | 'week'> {
  const models = new Map<string, ClaudeModelUsage>();
  const webSearch = { requests: 0, costUsd: 0 };
  const transcription = { seconds: 0, costUsd: 0 };
  const speech = { characters: 0, costUsd: 0 };
  for (const line of lines) {
    if (line.metric.startsWith('claude.')) {
      const lastDot = line.metric.lastIndexOf('.');
      const model = line.metric.slice('claude.'.length, lastDot);
      const kind = line.metric.slice(lastDot + 1);
      let entry = models.get(model);
      if (!entry) {
        entry = { model, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
        models.set(model, entry);
      }
      entry.costUsd += line.costUsd;
      if (kind === 'requests') entry.requests += line.quantity;
      else if (kind === 'input_tokens') entry.inputTokens += line.quantity;
      else if (kind === 'output_tokens') entry.outputTokens += line.quantity;
      else if (kind === 'cache_read_tokens') entry.cacheReadTokens += line.quantity;
      else if (kind.startsWith('cache_write')) entry.cacheWriteTokens += line.quantity;
    } else if (line.metric === 'web_search.requests') {
      webSearch.requests += line.quantity;
      webSearch.costUsd += line.costUsd;
    } else if (line.metric === 'transcribe.seconds') {
      transcription.seconds += line.quantity;
      transcription.costUsd += line.costUsd;
    } else if (line.metric.startsWith('polly.')) {
      speech.characters += line.quantity;
      speech.costUsd += line.costUsd;
    }
  }
  return { claude: [...models.values()].sort((a, b) => b.costUsd - a.costUsd), webSearch, transcription, speech };
}
