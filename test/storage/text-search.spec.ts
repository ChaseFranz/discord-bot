import { queryTerms, rankByRelevance, tokenize } from '../../src/storage/search/textSearch.js';

describe('in-code text search', () => {
  it('tokenizes like SQLite FTS5 with the porter tokenizer', () => {
    expect(tokenize('Flights to TOKYO, booking now!')).toEqual(['flight', 'to', 'tokyo', 'book', 'now']);
    expect(tokenize('Café crème — naïve')).toEqual(['cafe', 'creme', 'naiv']);
    expect(tokenize('レポート 2026')).toEqual(['レポート', '2026']);
    expect(queryTerms('"); DROP TABLE x; --')).toEqual(['drop', 'tabl', 'x']);
    expect(queryTerms('  ¿¡ !! ')).toEqual([]);
    expect(queryTerms('a '.repeat(40) + 'b c d e f g h i j k l m n o p q')).toHaveLength(16);
  });

  const docs = [
    { id: 1, text: 'did anyone watch the game last night', who: 'Alex' },
    { id: 2, text: 'we should plan a trip to Japan next spring', who: 'Sam' },
    { id: 3, text: 'Japan sounds great but flights are pricey', who: 'Chase' },
    { id: 4, text: 'book by January then, Japan flights get cheaper', who: 'Sam' },
  ];
  const fields = [
    { text: (d: (typeof docs)[number]) => d.text, weight: 1 },
    { text: (d: (typeof docs)[number]) => d.who, weight: 0.5 },
  ];

  it('returns only documents matching some word, more and rarer words first', () => {
    // 3 and 4 both match both words; the shorter line ranks higher, as with BM25 in SQLite.
    expect(rankByRelevance(docs, 'japan flight', fields, 10).map((d) => d.id)).toEqual([3, 4, 2]);
    expect(rankByRelevance(docs, 'game', fields, 10).map((d) => d.id)).toEqual([1]);
    expect(rankByRelevance(docs, 'nothing here matches', fields, 10)).toEqual([]);
    expect(rankByRelevance(docs, 'japan', fields, 2)).toHaveLength(2);
  });

  it('searches the weighted second field too', () => {
    expect(rankByRelevance(docs, 'chase', fields, 10).map((d) => d.id)).toEqual([3]);
  });
});
