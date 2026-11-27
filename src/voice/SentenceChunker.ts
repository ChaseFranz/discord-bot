export interface ChunkerOptions {
  /** A piece shorter than this waits for the next sentence (very short pieces sound choppy). */
  minChars: number;
  /** A run of text with no sentence end is cut at a comma or space once it is this long. */
  maxChars: number;
}

const DEFAULT_OPTIONS: ChunkerOptions = { minChars: 12, maxChars: 260 };

/** Words that end with a period without ending the sentence. */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'ft', 'vs', 'etc', 'eg', 'ie', 'approx', 'inc', 'ltd', 'co', 'no', 'vol',
]);

/**
 * Splits streamed text into speakable pieces as it arrives: each complete sentence (or line) is
 * emitted as soon as it ends, so speech can start before the whole reply has been written.
 */
export class SentenceChunker {
  private buffer = '';
  private readonly options: ChunkerOptions;

  constructor(
    private readonly emit: (piece: string) => void,
    options: Partial<ChunkerOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  push(delta: string): void {
    this.buffer += delta;
    this.drain();
  }

  /** Emits whatever is left (call once the reply is complete). */
  flush(): void {
    this.drain();
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest.length > 0) this.emit(rest);
  }

  private drain(): void {
    for (let cut = this.findCut(); cut !== undefined; cut = this.findCut()) {
      const piece = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (piece.length > 0) this.emit(piece);
    }
  }

  private findCut(): number | undefined {
    // A sentence end is . ! ? or … (with any closing quotes/brackets) followed by whitespace, or a line break.
    const boundary = /[.!?…]+["'”’)\]]*(?=\s)|\n/g;
    for (let match = boundary.exec(this.buffer); match; match = boundary.exec(this.buffer)) {
      const end = match.index + match[0].length;
      if (match[0] !== '\n' && this.isAbbreviation(match.index)) continue;
      if (this.buffer.slice(0, end).trim().length < this.options.minChars) continue;
      return end;
    }
    if (this.buffer.length <= this.options.maxChars) return undefined;
    const window = this.buffer.slice(0, this.options.maxChars);
    const clause = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
    if (clause > this.options.maxChars / 3) return clause + 1;
    const space = window.lastIndexOf(' ');
    return space > 0 ? space : this.options.maxChars;
  }

  /** True when the period at `index` ends an abbreviation, an initial, or a list number. */
  private isAbbreviation(index: number): boolean {
    if (this.buffer[index] !== '.') return false;
    const text = this.buffer.slice(0, index);
    // Dotted abbreviations: "e.g.", "i.e.", "U.S.".
    if (/(?:^|[^\p{L}])(?:\p{L}\.)+\p{L}$/u.test(text)) return true;
    const before = /([\p{L}\p{N}]+)$/u.exec(text);
    if (!before) return false;
    const word = before[1]!;
    if (ABBREVIATIONS.has(word.toLowerCase())) return true;
    if (word.length === 1 && /\p{Lu}/u.test(word)) return true; // an initial: "J. R. R. Tolkien"
    // "1. " at the start of a line is a list number.
    const lineStart = this.buffer.lastIndexOf('\n', index) + 1;
    return /^\d+$/.test(word) && this.buffer.slice(lineStart, index).trim() === word;
  }
}
