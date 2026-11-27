import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { collectSources, collectText, contentForTurnReplay, finalizeTurn, toReplayableBlocks } from '../../src/assistant/history.js';

describe('toReplayableBlocks', () => {
  it('drops thinking, fallback and empty text blocks; keeps text, tool and server-tool blocks', () => {
    const blocks = toReplayableBlocks([
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'redacted_thinking', data: 'x' },
      { type: 'text', text: '   ' },
      { type: 'text', text: 'Hello', citations: null },
      { type: 'tool_use', id: 't1', name: 'play_music', input: { query: 'jazz' } },
      { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
    ] as never);
    expect(blocks).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 't1', name: 'play_music', input: { query: 'jazz' } },
    ]);
  });
});

describe('finalizeTurn', () => {
  it('keeps a complete tool round trip and strips thinking', () => {
    const turn: BetaMessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'play jazz' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 's1' },
          { type: 'tool_use', id: 't1', name: 'play_music', input: { query: 'jazz' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's2' }, { type: 'text', text: 'Playing.' }] },
    ];
    expect(finalizeTurn(turn)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'play jazz' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'play_music', input: { query: 'jazz' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Playing.' }] },
    ]);
  });

  it('drops a tool call that never got a result (e.g. cut off at max_tokens)', () => {
    const turn: BetaMessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Let me' }, { type: 'tool_use', id: 't9', name: 'x', input: {} }] },
    ];
    expect(finalizeTurn(turn)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Let me' }] },
    ]);
  });

  it('merges a pause_turn continuation into one assistant message and keeps paired server tools', () => {
    const search = { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'weather' } };
    const result = { type: 'web_search_tool_result', tool_use_id: 's1', content: [] };
    const turn = [
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      { role: 'assistant', content: [search] },
      { role: 'assistant', content: [result, { type: 'text', text: 'Sunny.' }] },
    ] as never as BetaMessageParam[];
    expect(finalizeTurn(turn)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      { role: 'assistant', content: [search, result, { type: 'text', text: 'Sunny.' }] },
    ]);
  });

  it('drops an unpaired server tool call and the citations that depended on it', () => {
    const turn = [
      { role: 'user', content: [{ type: 'text', text: 'news?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'news' } },
          { type: 'text', text: 'Something happened.', citations: [{ type: 'web_search_result_location', url: 'u', title: 't', encrypted_index: 'e', cited_text: 'c' }] },
        ],
      },
    ] as never as BetaMessageParam[];
    expect(finalizeTurn(turn)[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Something happened.' }] });
  });

  it('removes an assistant message that only held thinking, merging the user messages around it', () => {
    const turn: BetaMessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }] },
    ];
    expect(finalizeTurn(turn)).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });
});

describe('contentForTurnReplay', () => {
  it('leaves ordinary responses (thinking included) untouched', () => {
    const content = [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 't', name: 'n', input: {} }] as never;
    expect(contentForTurnReplay(content)).toEqual(content);
  });

  it('drops the declined model\'s thinking and tool calls before a mid-output fallback boundary', () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'declined' },
      { type: 'text', text: 'Partial ' },
      { type: 'tool_use', id: 'cut', name: 'lookup', input: { q: 'x' } },
      { type: 'server_tool_use', id: 'orphan', name: 'web_search', input: {} },
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
      { type: 'thinking', thinking: '', signature: 'fallback' },
      { type: 'text', text: 'answer.' },
    ] as never;
    expect(contentForTurnReplay(content)).toEqual([
      { type: 'text', text: 'Partial ' },
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
      { type: 'thinking', thinking: '', signature: 'fallback' },
      { type: 'text', text: 'answer.' },
    ]);
  });
});

describe('collectText / collectSources', () => {
  it('joins text and de-duplicates web citations', () => {
    const blocks = [
      { type: 'text', text: 'Sunny ', citations: [{ type: 'web_search_result_location', url: 'https://a', title: 'A', encrypted_index: 'x', cited_text: 'y' }] },
      { type: 'tool_use', id: 't', name: 'n', input: {} },
      { type: 'text', text: 'and warm.', citations: [{ type: 'web_search_result_location', url: 'https://a', title: 'A', encrypted_index: 'x', cited_text: 'y' }] },
    ] as never;
    expect(collectText(blocks)).toBe('Sunny and warm.');
    expect(collectSources(blocks)).toEqual([{ url: 'https://a', title: 'A' }]);
  });
});
