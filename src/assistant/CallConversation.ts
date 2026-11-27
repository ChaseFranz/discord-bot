import type { BetaContentBlockParam, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ConversationMessage } from '../storage/ports.js';
import { buildBotNote, buildCallLines, type CallLine } from './prompts.js';

/** `size` is roughly how many characters the entry adds to a request. */
type Entry =
  /** A stretch of what people said, in order. */
  | { kind: 'heard'; id: number; size: number; lines: CallLine[] }
  /** Something the bot tells the model about what happened (how much of a reply was heard, say). */
  | { kind: 'note'; id: number; size: number; text: string }
  /** One turn of the model: its messages, with any tool calls and their results. */
  | { kind: 'reply'; id: number; size: number; messages: readonly ConversationMessage[] };

/** "Everything heard up to here": what a turn had seen when it was sent to the model. */
export interface CallMark {
  /** The last entry at that moment, and how many lines it held if it is a stretch of speech. */
  readonly entryId: number;
  readonly lines: number;
}

export interface CallWindowPolicy {
  /** Once the conversation is larger than this (in characters, roughly four per token)... */
  maxChars: number;
  /** ...the oldest part is dropped until it is no larger than this. */
  keepChars: number;
}

const DEFAULT_WINDOW: CallWindowPolicy = { maxChars: 160_000, keepChars: 80_000 };
/** A stretch of speech is closed after this many lines, so old speech can be dropped in pieces. */
const MAX_LINES_PER_STRETCH = 40;

/**
 * The conversation of one call, shared by everyone in it: what people said, what the assistant said
 * back, and notes on what was actually heard. It is the context for every model call in the call.
 *
 * It lives in memory for as long as the bot is listening: the transcript is the lasting record, and
 * older parts dropped from here can still be looked up there. Everything is append-only apart from
 * dropping the oldest part, so each request repeats the last one's start exactly (which is what
 * lets the prompt cache work).
 */
export class CallConversation {
  private entries: Entry[] = [];
  private nextId = 1;
  private size = 0;

  constructor(
    private readonly timeZone: string,
    private readonly window: CallWindowPolicy = DEFAULT_WINDOW,
  ) {}

  /** Records something said in the call. */
  hear(line: CallLine): void {
    const last = this.entries.at(-1);
    const size = lineSize(line);
    if (last?.kind === 'heard' && last.lines.length < MAX_LINES_PER_STRETCH) {
      last.lines.push(line);
      last.size += size;
    } else {
      this.entries.push({ kind: 'heard', id: this.nextId++, size, lines: [line] });
    }
    this.size += size;
    this.trim();
  }

  /** Records a note from the bot, placed after everything heard so far. */
  note(text: string): void {
    const size = text.length + OVERHEAD;
    this.entries.push({ kind: 'note', id: this.nextId++, size, text });
    this.size += size;
  }

  /** Marks the current end of the conversation. */
  mark(): CallMark {
    const last = this.entries.at(-1);
    return { entryId: last?.id ?? 0, lines: last?.kind === 'heard' ? last.lines.length : 0 };
  }

  /** True if anything has been heard or noted since `mark`. */
  movedSince(mark: CallMark): boolean {
    const now = this.mark();
    return now.entryId !== mark.entryId || now.lines !== mark.lines;
  }

  /**
   * Records a turn of the model as coming right after `mark`: whatever was heard while it was
   * being written stays after it, in the order it happened. Returns false if the conversation has
   * moved on so far that the marked point is gone (the turn is then not recorded).
   */
  reply(mark: CallMark, messages: readonly ConversationMessage[]): boolean {
    if (messages.length === 0) return true;
    const index = this.entries.findIndex((candidate) => candidate.id === mark.entryId);
    if (index < 0) return false;
    const entry: Entry = { kind: 'reply', id: this.nextId++, size: JSON.stringify(messages).length, messages };
    const marked = this.entries[index]!;
    if (marked.kind === 'heard' && marked.lines.length > mark.lines) {
      // Lines arrived after the turn was sent: they belong after the reply.
      const later = marked.lines.splice(mark.lines);
      const laterSize = later.reduce((total, line) => total + lineSize(line), 0);
      marked.size -= laterSize;
      this.entries.splice(index + 1, 0, entry, { kind: 'heard', id: this.nextId++, size: laterSize, lines: later });
    } else {
      this.entries.splice(index + 1, 0, entry);
    }
    this.size += entry.size;
    this.trim();
    return true;
  }

  /**
   * Takes out what was heard between the last turn of the model and `mark`, leaving `note` in its
   * place. Used when the model declined to respond to it: left in, it would be sent again with
   * every later turn. Anything heard after `mark` stays.
   */
  strike(mark: CallMark, note: string): void {
    const end = this.entries.findIndex((candidate) => candidate.id === mark.entryId);
    if (end < 0) return;
    let start = end;
    while (start > 0 && this.entries[start - 1]!.kind !== 'reply') start--;
    if (this.entries[start]!.kind === 'reply') start++;
    const marked = this.entries[end]!;
    const later = marked.kind === 'heard' ? marked.lines.slice(mark.lines) : [];
    const replacement: Entry[] = [{ kind: 'note', id: this.nextId++, size: note.length + OVERHEAD, text: note }];
    if (later.length > 0) {
      replacement.push({ kind: 'heard', id: this.nextId++, size: later.reduce((total, line) => total + lineSize(line), 0), lines: later });
    }
    this.entries.splice(start, end - start + 1, ...replacement);
    this.size = this.entries.reduce((total, entry) => total + entry.size, 0);
  }

  /**
   * The conversation as Messages API messages, up to `mark` (default: all of it). Blocks are fresh
   * copies, so the caller can put a cache breakpoint on the last one.
   */
  messages(mark: CallMark = this.mark()): BetaMessageParam[] {
    const out: Array<{ role: 'user' | 'assistant'; content: BetaContentBlockParam[] }> = [];
    const add = (role: 'user' | 'assistant', blocks: readonly BetaContentBlockParam[]) => {
      const last = out.at(-1);
      // Neighbours on the same side are one message: tool results first, then what was heard next.
      if (last && last.role === role) last.content.push(...blocks.map((block) => ({ ...block })));
      else out.push({ role, content: blocks.map((block) => ({ ...block })) });
    };
    for (const entry of this.entries) {
      if (entry.kind === 'heard') {
        const lines = entry.id === mark.entryId ? entry.lines.slice(0, mark.lines) : entry.lines;
        if (lines.length > 0) add('user', [{ type: 'text', text: buildCallLines(lines, this.timeZone) }]);
      } else if (entry.kind === 'note') {
        add('user', [{ type: 'text', text: buildBotNote(entry.text) }]);
      } else {
        for (const message of entry.messages) add(message.role, message.content);
      }
      if (entry.id === mark.entryId) break;
    }
    return out;
  }

  /** Drops the oldest part once the conversation has grown past the window. */
  private trim(): void {
    if (this.size <= this.window.maxChars) return;
    // Cut only where what remains starts with something heard (never with half a turn of the model),
    // and always keep the newest entry.
    let cut = 0;
    let remaining = this.size;
    let kept = this.size;
    for (let index = 0; index < this.entries.length - 1 && kept > this.window.keepChars; index++) {
      remaining -= this.entries[index]!.size;
      if (this.entries[index + 1]!.kind !== 'heard') continue;
      cut = index + 1;
      kept = remaining;
    }
    if (cut === 0) return;
    this.entries.splice(0, cut);
    this.size = kept;
  }
}

/** Characters each line or note adds around its text (the time, the tags). */
const OVERHEAD = 24;

function lineSize(line: CallLine): number {
  return line.text.length + line.speakerName.length + OVERHEAD;
}
