/**
 * List prices used to estimate what the bot spends. They're estimates for the daily budget and
 * /usage; your Anthropic or AWS bill is authoritative. Claude Platform on AWS bills the same USD
 * rates (converted to Claude Consumption Units).
 *
 * Sources (checked 2026-11-26):
 *  - Claude: https://platform.claude.com/docs/en/about-claude/pricing
 *  - Transcribe streaming, us-east-1: $0.0001667 per second, no per-request minimum
 *    (AWS price list, effective 2026-11-01).
 *  - Polly, per million characters: standard $4, neural $16, long-form $100, generative $30.
 */

/** USD per million tokens. */
export interface ClaudeRates {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

interface ModelPricing {
  standard: ClaudeRates;
  /** A higher rate card for requests whose prompt (all input tokens, cached included) exceeds the threshold. */
  longPrompt?: { aboveTokens: number; rates: ClaudeRates };
}

const rates = (input: number, output: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number): ClaudeRates => ({
  input,
  output,
  cacheWrite5m,
  cacheWrite1h,
  cacheRead,
});

const CLAUDE_PRICES: Record<string, ModelPricing> = {
  'claude-opus-5-5': { standard: rates(4, 20, 5, 8, 0.2) },
  'claude-haiku-5-5': {
    standard: rates(0.1, 0.5, 0.125, 0.2, 0.01),
    longPrompt: { aboveTokens: 100_000, rates: rates(0.5, 2.5, 0.625, 1, 0.05) },
  },
  'claude-sonnet-5-5': { standard: rates(2, 10, 2.5, 4, 0.1) },
  'claude-opus-5': { standard: rates(5, 25, 6.25, 10, 0.5) },
  'claude-fable-5-2': { standard: rates(8, 40, 10, 16, 0.2) },
  'claude-fable-5-1': { standard: rates(10, 50, 12.5, 20, 0.25) },
};

/** Used for a model that isn't in the table: the highest rates listed, so the budget errs on the safe side. */
const UNKNOWN_MODEL_RATES = rates(10, 50, 12.5, 20, 0.25);

/** Web search: $10 per 1,000 searches (failed searches aren't billed). */
const WEB_SEARCH_USD = 10 / 1_000;

export const DEFAULT_TRANSCRIBE_USD_PER_MINUTE = 0.01;

/** Polly list prices per million characters, by engine. */
export const POLLY_USD_PER_MILLION_CHARACTERS: Record<string, number> = {
  standard: 4,
  neural: 16,
  'long-form': 100,
  generative: 30,
};

export interface PriceBookOptions {
  transcribeUsdPerMinute?: number;
  /** Polly engine in use and, optionally, its price per million characters (else the list price). */
  pollyEngine: string;
  pollyUsdPerMillionCharacters?: number;
}

export class PriceBook {
  readonly transcribeUsdPerSecond: number;
  readonly pollyUsdPerCharacter: number;
  readonly webSearchUsd = WEB_SEARCH_USD;

  constructor(options: PriceBookOptions) {
    this.transcribeUsdPerSecond = (options.transcribeUsdPerMinute ?? DEFAULT_TRANSCRIBE_USD_PER_MINUTE) / 60;
    const pollyPerMillion =
      options.pollyUsdPerMillionCharacters ?? POLLY_USD_PER_MILLION_CHARACTERS[options.pollyEngine] ?? POLLY_USD_PER_MILLION_CHARACTERS.generative!;
    this.pollyUsdPerCharacter = pollyPerMillion / 1_000_000;
  }

  /** Rates for one request to `model` with a prompt of `promptTokens` input tokens (cached included). */
  claudeRates(model: string, promptTokens: number): ClaudeRates {
    const pricing = findPricing(model);
    if (!pricing) return UNKNOWN_MODEL_RATES;
    if (pricing.longPrompt && promptTokens > pricing.longPrompt.aboveTokens) return pricing.longPrompt.rates;
    return pricing.standard;
  }

  /** Whether `model` has a listed price (unknown models are charged the highest listed rates). */
  isKnownModel(model: string): boolean {
    return findPricing(model) !== undefined;
  }
}

/** Matches dated or suffixed ids too (`claude-opus-5-5-20261101`), preferring the longest known prefix. */
function findPricing(model: string): ModelPricing | undefined {
  let best: string | undefined;
  for (const id of Object.keys(CLAUDE_PRICES)) {
    if ((model === id || model.startsWith(`${id}-`)) && (best === undefined || id.length > best.length)) best = id;
  }
  return best ? CLAUDE_PRICES[best] : undefined;
}
