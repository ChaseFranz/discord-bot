import { KeyedMutex } from '../../src/util/KeyedMutex.js';
import { chunkText, toSpeakableText, truncate } from '../../src/util/text.js';

describe('toSpeakableText', () => {
  it('strips markdown, links and URLs for text-to-speech', () => {
    expect(toSpeakableText('**Sure!** Check [the docs](https://x.y) or https://a.b/c now.\n- one\n- two')).toBe(
      'Sure! Check the docs or now. one two',
    );
    expect(toSpeakableText('# Title\n`code` and ```\nblock\n``` done')).toBe('Title code and done');
  });

  it('cuts long text at a sentence boundary', () => {
    const text = `${'This is a sentence. '.repeat(20)}`;
    const out = toSpeakableText(text, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('.')).toBe(true);
  });
});

describe('chunkText', () => {
  it('splits on paragraph, line, sentence then word boundaries and never exceeds the limit', () => {
    const text = `${'word '.repeat(50)}\n\n${'line one\n'.repeat(5)}${'x'.repeat(30)}`;
    const chunks = chunkText(text, 60);
    expect(chunks.every((c) => c.length > 0 && c.length <= 60)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(text.trim().replace(/\s+/g, ' '));
  });

  it('returns one chunk for short text', () => {
    expect(chunkText('  hello  ', 100)).toEqual(['hello']);
    expect(truncate('abcdef', 4)).toBe('abc…');
  });
});

describe('KeyedMutex', () => {
  it('runs same-key tasks in order and different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const task = (name: string, ms: number) => async () => {
      events.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      events.push(`${name}:end`);
      return name;
    };
    const results = await Promise.all([mutex.run('a', task('a1', 20)), mutex.run('a', task('a2', 1)), mutex.run('b', task('b1', 1))]);
    expect(results).toEqual(['a1', 'a2', 'b1']);
    expect(events.indexOf('a2:start')).toBeGreaterThan(events.indexOf('a1:end'));
    expect(events.indexOf('b1:start')).toBeLessThan(events.indexOf('a1:end'));
  });

  it('keeps going after a task fails', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run('k', async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(mutex.run('k', async () => 'ok')).resolves.toBe('ok');
  });
});
