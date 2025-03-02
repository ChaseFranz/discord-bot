export class KeywordDetector {
  private keyword: string = "jarvis";
  // Maximum allowed edit distance for a match. Adjust this value for sensitivity.
  private threshold: number = 2;

  /**
   * Computes the Levenshtein distance between two strings using a two-row dynamic programming approach.
   * Exits early if the minimum value in a row exceeds the threshold.
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

    let previousRow: number[] = new Array(aLen + 1);
    let currentRow: number[] = new Array(aLen + 1);

    // Initialize the first row: cost of deletions.
    for (let i = 0; i <= aLen; i++) {
      previousRow[i] = i;
    }

    for (let j = 1; j <= bLen; j++) {
      currentRow[0] = j;
      let rowMin = currentRow[0];

      for (let i = 1; i <= aLen; i++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        currentRow[i] = Math.min(
          previousRow[i] + 1,       // deletion
          currentRow[i - 1] + 1,      // insertion
          previousRow[i - 1] + cost   // substitution
        );
        rowMin = Math.min(rowMin, currentRow[i]);
      }

      // Early termination if the smallest edit distance in this row is above the threshold.
      if (rowMin > this.threshold) {
        return this.threshold + 1;
      }

      // Swap rows for the next iteration.
      [previousRow, currentRow] = [currentRow, previousRow];
    }

    return previousRow[aLen];
  }

  /**
   * Checks if the input string contains a word similar to the keyword, within the specified edit distance threshold.
   */
  public containsKeyword(input: string): boolean {
    const normalizedInput = input.toLowerCase();
    const normalizedKeyword = this.keyword.toLowerCase();

    // Quick check for an exact (or substring) match.
    if (normalizedInput.includes(normalizedKeyword)) {
      return true;
    }

    // Split input into words and check each word's edit distance.
    const words = normalizedInput.split(/\W+/);
    return words.some(word => this.levenshteinDistance(word, normalizedKeyword) <= this.threshold);
  }
}
