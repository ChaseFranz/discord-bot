const MAX_TERMS = 16;

/**
 * Converts free text (typically a model-written search query) into a safe FTS5 MATCH
 * expression. Every term is quoted, so FTS5 operators or punctuation in the input can't
 * cause syntax errors; terms are OR-ed so BM25 ranks rows that match more of them higher.
 *
 * Returns undefined when the input contains no searchable terms.
 */
export function toFtsQuery(input: string): string | undefined {
  const terms = new Set<string>();
  for (const raw of input.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length === 0) continue;
    terms.add(raw);
    if (terms.size >= MAX_TERMS) break;
  }
  if (terms.size === 0) return undefined;
  return [...terms].map((term) => `"${term}"`).join(' OR ');
}

/** Escapes `%`, `_` and `\` for use in a `LIKE ... ESCAPE '\'` pattern. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
