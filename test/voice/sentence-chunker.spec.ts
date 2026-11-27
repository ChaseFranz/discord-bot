import { SentenceChunker } from '../../src/voice/SentenceChunker.js';

function chunk(deltas: string[], options = {}): string[] {
  const pieces: string[] = [];
  const chunker = new SentenceChunker((piece) => pieces.push(piece), options);
  for (const delta of deltas) chunker.push(delta);
  chunker.flush();
  return pieces;
}

describe('SentenceChunker', () => {
  it('emits each sentence as soon as it ends', () => {
    const pieces: string[] = [];
    const chunker = new SentenceChunker((piece) => pieces.push(piece));
    chunker.push('The weather is sunny today. It');
    expect(pieces).toEqual(['The weather is sunny today.']);
    chunker.push(' will rain tomorrow! Bring an umbrella?');
    expect(pieces).toEqual(['The weather is sunny today.', 'It will rain tomorrow!']);
    chunker.flush();
    expect(pieces.at(-1)).toBe('Bring an umbrella?');
  });

  it("doesn't split decimals, abbreviations, initials or list numbers", () => {
    expect(chunk(['It costs 3.5 dollars at Dr. Smith\'s shop, e.g. on Main St. near the park. Done.'])).toEqual([
      "It costs 3.5 dollars at Dr. Smith's shop, e.g. on Main St. near the park.",
      'Done.',
    ]);
    expect(chunk(['J. R. R. Tolkien wrote it. Truly great.'])).toEqual(['J. R. R. Tolkien wrote it.', 'Truly great.']);
    expect(chunk(['Steps:\n1. Preheat the oven\n2. Bake it'])).toEqual(['Steps:\n1. Preheat the oven', '2. Bake it']);
  });

  it('keeps very short sentences with the next one, and cuts long runs at a comma', () => {
    expect(chunk(['Sure. The pizza place opens at nine.'])).toEqual(['Sure. The pizza place opens at nine.']);
    const long = `${'word '.repeat(30)}and then, ${'more '.repeat(30)}`;
    const pieces = chunk([long], { maxChars: 120 });
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.length <= 120)).toBe(true);
  });

  it('handles quotes after the full stop and line breaks', () => {
    expect(chunk(['She said "it\'s fine." Then she left.\nThe end'])).toEqual(['She said "it\'s fine."', 'Then she left.', 'The end']);
  });
});
