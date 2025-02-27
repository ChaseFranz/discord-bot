export class KeywordDetector {
    private keyword: string = "jarvis";
    // Maximum allowed edit distance for a match. Adjust this value for sensitivity.
    private threshold: number = 2;
  
    // Computes the Levenshtein distance between two strings.
    private levenshteinDistance(a: string, b: string): number {
      const matrix: number[][] = [];
  
      // If one of the strings is empty, return the length of the other
      if (a.length === 0) return b.length;
      if (b.length === 0) return a.length;
  
      // Initialize the first row and column of the matrix.
      for (let i = 0; i <= a.length; i++) {
        matrix[i] = [i];
      }
      for (let j = 0; j <= b.length; j++) {
        matrix[0][j] = j;
      }
  
      // Fill in the rest of the matrix.
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          matrix[i][j] = Math.min(
            matrix[i - 1][j] + 1,      // deletion
            matrix[i][j - 1] + 1,      // insertion
            matrix[i - 1][j - 1] + cost // substitution
          );
        }
      }
  
      return matrix[a.length][b.length];
    }
  
    // Checks if the input string contains a word similar to "Jarvis".
    public containsKeyword(input: string): boolean {
      // Normalize the input and keyword to lower-case.
      const normalizedInput = input.toLowerCase();
      const normalizedKeyword = this.keyword.toLowerCase();
      // Split input by non-word characters.
      const words = normalizedInput.split(/\W+/);
      // Check if any word's edit distance to "jarvis" is within the threshold.
      return words.some(word => this.levenshteinDistance(word, normalizedKeyword) <= this.threshold);
    }
  }

  