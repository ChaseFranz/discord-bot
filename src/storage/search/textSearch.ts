import { stemmer } from 'stemmer';

/**
 * Keyword search done in code, for stores without built-in full-text search (DynamoDB). It mirrors
 * what the SQLite stores get from FTS5 with the `porter unicode61` tokenizer and `bm25()` ranking:
 * words are lowercased, accents are folded and English endings stemmed ("flights" and "flight"
 * match), any query word can match, and documents matching more and rarer words rank higher.
 */

/** Most distinct words used from one query, as in the SQLite stores. */
const MAX_QUERY_TERMS = 16;
const K1 = 1.2;
const B = 0.75;

/** Splits text into stemmed, lowercased words, with accents removed from Latin letters. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFKD')
    // Like FTS5's remove_diacritics: only Latin letters lose their marks ("café" -> "cafe");
    // in other scripts a mark changes the letter (Japanese "ポ" is not "ホ"), so recompose those.
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
    .map((word) => (/^[a-z]+$/.test(word) ? stemmer(word) : word));
}

/** The distinct search words in a query (at most 16), or [] when it has none. */
export function queryTerms(query: string): string[] {
  return [...new Set(tokenize(query))].slice(0, MAX_QUERY_TERMS);
}

/** A searchable field of a document, with its weight in the ranking. */
export interface SearchField<T> {
  text: (item: T) => string;
  weight: number;
}

/**
 * Ranks `items` against `query` with BM25 over the given fields (each field scored on its own and
 * weighted). Only items containing at least one query word are returned, best first; ties keep
 * the input order.
 */
export function rankByRelevance<T>(items: readonly T[], query: string, fields: ReadonlyArray<SearchField<T>>, limit: number): T[] {
  const terms = queryTerms(query);
  if (terms.length === 0 || items.length === 0 || limit <= 0) return [];

  const tokenized = items.map((item) => fields.map((field) => tokenize(field.text(item))));
  const averageLength = fields.map((_, f) => tokenized.reduce((sum, doc) => sum + doc[f]!.length, 0) / items.length || 1);
  // Documents containing each term, per field.
  const containing = fields.map((_, f) =>
    terms.map((term) => tokenized.reduce((count, doc) => count + (doc[f]!.includes(term) ? 1 : 0), 0)),
  );

  const scored: Array<{ item: T; index: number; score: number }> = [];
  tokenized.forEach((doc, index) => {
    let score = 0;
    let matched = false;
    fields.forEach((field, f) => {
      const words = doc[f]!;
      if (words.length === 0) return;
      terms.forEach((term, t) => {
        const frequency = words.reduce((count, word) => count + (word === term ? 1 : 0), 0);
        if (frequency === 0) return;
        matched = true;
        const n = containing[f]![t]!;
        // FTS5's IDF, floored so very common words still count a little.
        const idf = Math.max(Math.log((items.length - n + 0.5) / (n + 0.5)), 1e-6);
        const lengthNorm = 1 - B + (B * words.length) / averageLength[f]!;
        score += field.weight * idf * ((frequency * (K1 + 1)) / (frequency + K1 * lengthNorm));
      });
    });
    if (matched) scored.push({ item: items[index]!, index, score });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}
