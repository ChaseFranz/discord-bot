/**
 * Fuzzy wake-word detection over transcribed speech. Speech-to-text often mangles a name
 * ("Nimbus" -> "nimbis", "nimbo"), so a word within a small edit distance also counts.
 */
export class KeywordDetector {
  private readonly keyword: string;
  private readonly threshold: number;

  /**
   * @param keyword   Wake word to look for (case-insensitive).
   * @param threshold Maximum Levenshtein distance for a fuzzy match. Defaults to 2 for words of
   *                  six or more letters and 1 for shorter ones, so short names don't match
   *                  half the dictionary.
   */
  constructor(keyword: string = 'nimbus', threshold?: number) {
    this.keyword = keyword.toLowerCase().trim();
    if (this.keyword.length === 0) throw new Error('Wake word must not be empty');
    this.threshold = threshold ?? (this.keyword.length >= 6 ? 2 : 1);
  }

  /**
   * Computes the Levenshtein distance between two strings using a two-row dynamic programming approach.
   * Exits early once every value in a row exceeds the threshold.
   */
  private levenshteinDistance(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // Ensure a is the shorter string to use less space.
    if (a.length > b.length) {
      [a, b] = [b, a];
    }

    const aLen = a.length;
    const bLen = b.length;

    let previousRow: number[] = Array.from({ length: aLen + 1 }, (_, i) => i);
    let currentRow: number[] = new Array<number>(aLen + 1).fill(0);

    for (let j = 1; j <= bLen; j++) {
      currentRow[0] = j;
      let rowMin = j;

      for (let i = 1; i <= aLen; i++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        const value = Math.min(
          previousRow[i]! + 1, // deletion
          currentRow[i - 1]! + 1, // insertion
          previousRow[i - 1]! + cost, // substitution
        );
        currentRow[i] = value;
        rowMin = Math.min(rowMin, value);
      }

      if (rowMin > this.threshold) {
        return this.threshold + 1;
      }

      [previousRow, currentRow] = [currentRow, previousRow];
    }

    return previousRow[aLen]!;
  }

  /** True if the input contains the wake word, exactly or within the edit-distance threshold. */
  public containsKeyword(input: string): boolean {
    const normalizedInput = input.toLowerCase();

    if (normalizedInput.includes(this.keyword)) {
      return true;
    }

    // Speech-to-text sometimes splits a name into words ("nim bus"): match it with spaces and
    // punctuation removed too. Exact only; ordinary speech essentially never spells the name
    // across a word boundary.
    if (normalizedInput.replace(/[^\p{L}\p{N}]+/gu, '').includes(this.keyword)) {
      return true;
    }

    const words = normalizedInput.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
    return words.some((word) => this.levenshteinDistance(word, this.keyword) <= this.threshold);
  }

  /**
   * The input with the wake word taken out ("Nimbus, stop." -> ", stop."), or undefined when it
   * doesn't contain the wake word. Removes every word that matches it, including a name split in
   * two ("nim bus"). If the wake word is buried inside a longer word, the input comes back whole.
   */
  public stripKeyword(input: string): string | undefined {
    if (!this.containsKeyword(input)) return undefined;
    const tokens = [...input.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      word: match[0].toLowerCase(),
    }));
    const remove = new Set<number>();
    tokens.forEach((token, index) => {
      if (token.word === this.keyword || this.levenshteinDistance(token.word, this.keyword) <= this.threshold) remove.add(index);
    });
    for (let index = 0; index + 1 < tokens.length; index++) {
      if (tokens[index]!.word + tokens[index + 1]!.word === this.keyword) remove.add(index).add(index + 1);
    }
    if (remove.size === 0) return input;
    let out = '';
    let cursor = 0;
    tokens.forEach((token, index) => {
      if (!remove.has(index)) return;
      // The gap between two removed pieces of a split name ("nim bus") goes too.
      const joinsPrevious = remove.has(index - 1) && cursor === tokens[index - 1]!.end && input.slice(cursor, token.start).trim() === '';
      if (!joinsPrevious) out += input.slice(cursor, token.start);
      cursor = token.end;
    });
    return out + input.slice(cursor);
  }
}
