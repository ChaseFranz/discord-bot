import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ConversationMessage } from '../storage/ports.js';

/**
 * Preparing completed turns for storage and replay.
 *
 * Stored history keeps text, client tool calls/results, and server tool (web search) blocks
 * verbatim, but drops every thinking block. That is deliberate:
 *  - The same thread is answered by different models (Opus for /chat, Haiku for voice), and
 *    thinking blocks are bound to the model and the exact conversation prefix that produced them.
 *  - The active window is shortened from the front over time; replaying thinking blocks after
 *    such an edit is rejected on accounts that enforce the history-editing check.
 * A history with no thinking blocks at all is always valid to replay, and because blocks are
 * stripped once, at storage time, every later request sends byte-identical history (so the prompt
 * cache still hits). Thinking is kept, untouched, within a turn's own tool loop where it's required.
 */

type AnyBlock = BetaContentBlock | BetaContentBlockParam;

type ServerResultBlock = Extract<BetaContentBlockParam, { type: 'web_search_tool_result' | 'web_fetch_tool_result' }>;

function isServerResult(block: BetaContentBlockParam): block is ServerResultBlock {
  return block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result';
}

/** Converts one message's blocks to the replayable subset. */
export function toReplayableBlocks(blocks: readonly AnyBlock[]): BetaContentBlockParam[] {
  const out: BetaContentBlockParam[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        if (block.text.trim().length === 0) break;
        const citations = 'citations' in block && Array.isArray(block.citations) && block.citations.length > 0 ? block.citations : undefined;
        out.push(citations ? ({ type: 'text', text: block.text, citations } as BetaContentBlockParam) : { type: 'text', text: block.text });
        break;
      }
      case 'tool_use':
        out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} });
        break;
      case 'tool_result':
        out.push(block);
        break;
      case 'server_tool_use':
      case 'web_search_tool_result':
      case 'web_fetch_tool_result':
        // Must be sent back exactly as received (encrypted content is validated).
        out.push(block as BetaContentBlockParam);
        break;
      default:
        // thinking, redacted_thinking, fallback, and anything model-internal or unknown.
        break;
    }
  }
  return out;
}

/**
 * Turns the messages produced during one turn (user message, assistant responses, tool results)
 * into what gets stored: replayable blocks only, tool calls paired with their results, consecutive
 * same-role messages merged (a `pause_turn` continuation is one assistant message), empties removed.
 */
export function finalizeTurn(messages: readonly BetaMessageParam[]): ConversationMessage[] {
  // 1. Keep only user/assistant messages and replayable blocks; merge same-role neighbours.
  const merged: ConversationMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const content = typeof message.content === 'string' ? toTextBlocks(message.content) : toReplayableBlocks(message.content ?? []);
    const last = merged.at(-1);
    if (last && last.role === message.role) {
      last.content.push(...content);
    } else {
      merged.push({ role: message.role, content });
    }
  }

  // 2. Pair client tool calls with results in the following user message; drop orphans either way.
  for (let i = 0; i < merged.length; i++) {
    const message = merged[i]!;
    if (message.role !== 'assistant') continue;
    const next = merged[i + 1];
    const resultIds = new Set(
      (next?.role === 'user' ? next.content : []).flatMap((block) => (block.type === 'tool_result' ? [block.tool_use_id] : [])),
    );
    message.content = message.content.filter((block) => block.type !== 'tool_use' || resultIds.has(block.id));
    const callIds = new Set(message.content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : [])));
    if (next?.role === 'user') {
      next.content = next.content.filter((block) => block.type !== 'tool_result' || callIds.has(block.tool_use_id));
    }

    // Server tool calls and their results live in the same assistant message; keep only complete pairs.
    const serverUseIds = new Set(message.content.flatMap((block) => (block.type === 'server_tool_use' ? [block.id] : [])));
    const serverResultIds = new Set(message.content.flatMap((block) => (isServerResult(block) ? [block.tool_use_id] : [])));
    const before = message.content.length;
    message.content = message.content.filter((block) => {
      if (block.type === 'server_tool_use') return serverResultIds.has(block.id);
      if (isServerResult(block)) return serverUseIds.has(block.tool_use_id);
      return true;
    });
    if (message.content.length !== before) {
      // Citations point into search results; without the complete set, send plain text.
      message.content = message.content.map((block) => (block.type === 'text' ? { type: 'text', text: block.text } : block));
    }
  }
  // Any tool_result left without a preceding assistant call (e.g. the first message) is invalid too.
  for (let i = 0; i < merged.length; i++) {
    const message = merged[i]!;
    if (message.role !== 'user') continue;
    const previous = merged[i - 1];
    const callIds = new Set((previous?.role === 'assistant' ? previous.content : []).flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])));
    message.content = message.content.filter((block) => block.type !== 'tool_result' || callIds.has(block.tool_use_id));
  }

  // 3. Drop empty messages, then re-merge neighbours that became adjacent.
  const result: ConversationMessage[] = [];
  for (const message of merged) {
    if (message.content.length === 0) continue;
    const last = result.at(-1);
    if (last && last.role === message.role) last.content.push(...message.content);
    else result.push({ role: message.role, content: [...message.content] });
  }
  return result;
}

const KEEP_BEFORE_FALLBACK = new Set(['text', 'fallback', 'server_tool_use', 'web_search_tool_result', 'web_fetch_tool_result']);

/**
 * Prepares a response's content to be sent back within the same turn (the tool loop).
 *
 * When a server-side fallback took over mid-output, the declined model's thinking and tool calls
 * before the (last) `fallback` block must not be echoed, and those cut-off tool calls must not run.
 * Text and complete server-tool pairs before the boundary stay; the fallback block stays in place.
 * Responses without a fallback block are returned unchanged (thinking included, as required).
 */
export function contentForTurnReplay(content: readonly BetaContentBlock[]): BetaContentBlock[] {
  const boundary = content.map((block) => block.type).lastIndexOf('fallback');
  if (boundary <= 0) return [...content];
  const before = content.slice(0, boundary);
  const resultIds = new Set(before.flatMap((block) => ('tool_use_id' in block && isServerResultType(block.type) ? [String(block.tool_use_id)] : [])));
  const kept = before.filter((block) => {
    if (!KEEP_BEFORE_FALLBACK.has(block.type)) return false;
    if (block.type === 'server_tool_use') return resultIds.has(block.id);
    return true;
  });
  return [...kept, ...content.slice(boundary)];
}

function isServerResultType(type: string): boolean {
  return type === 'web_search_tool_result' || type === 'web_fetch_tool_result';
}

function toTextBlocks(text: string): BetaContentBlockParam[] {
  return text.trim().length > 0 ? [{ type: 'text', text }] : [];
}

/** Text the assistant wrote in a set of blocks, joined into one reply. */
export function collectText(blocks: readonly AnyBlock[]): string {
  return blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();
}

export interface Source {
  title: string;
  url: string;
}

/** Unique web sources cited in a set of blocks, in first-cited order. */
export function collectSources(blocks: readonly AnyBlock[]): Source[] {
  const seen = new Map<string, Source>();
  for (const block of blocks) {
    if (block.type !== 'text' || !('citations' in block) || !Array.isArray(block.citations)) continue;
    for (const citation of block.citations as Array<{ type: string; url?: string; title?: string | null }>) {
      if (citation.type !== 'web_search_result_location' || !citation.url || seen.has(citation.url)) continue;
      seen.set(citation.url, { url: citation.url, title: citation.title ?? citation.url });
    }
  }
  return [...seen.values()];
}
