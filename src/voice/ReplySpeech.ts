import type { PieceEnding, SpeechQueue } from './SpeechQueue.js';

/** What a reply has got across so far. */
export interface SpeechProgress {
  /** Pieces heard in full, in order. */
  heard: string[];
  /** The piece that was being spoken when the reply was paused or cut off, if any. */
  interrupted: string | undefined;
  /** Pieces still waiting to be spoken. */
  unsaid: string[];
}

/** A reply spoken sentence by sentence; see SpeechQueue. */
export interface ReplySpeech {
  /** Speaks another piece of the reply after the ones already added. */
  say(text: string): void;
  cancel(): void;
  readonly cancelled: boolean;
  finished(): Promise<void>;
  /** True once any of it has started playing: from then on, people have heard part of it. */
  readonly audioStarted: boolean;
  /** Calls `listener` when the first piece starts playing (at once, if it already has). */
  onAudioStart(listener: () => void): void;
  progress(): SpeechProgress;
}

/**
 * Opens a reply on `queue` that keeps track of what has been heard of it. `prepare` turns one piece
 * of text into audio (text-to-speech); it runs ahead of time, while the piece before is playing.
 * Once `live` says no (the call has ended), further pieces are ignored.
 */
export function openReplySpeech<A>(queue: SpeechQueue<A>, prepare: (text: string) => Promise<A>, live: () => boolean = () => true): ReplySpeech {
  const reply = queue.openReply();
  const pieces: Array<{ text: string; state: 'waiting' | 'playing' | PieceEnding }> = [];
  let started = false;
  const startListeners: Array<() => void> = [];
  return {
    say: (text) => {
      if (!live()) return;
      const piece: (typeof pieces)[number] = { text, state: 'waiting' };
      pieces.push(piece);
      reply.add('part of a reply', () => prepare(text), {
        started: () => {
          piece.state = 'playing';
          if (started) return;
          started = true;
          for (const listener of startListeners.splice(0)) listener();
        },
        ended: (how) => {
          piece.state = how;
        },
      });
    },
    cancel: () => reply.cancel(),
    get cancelled() {
      return reply.cancelled;
    },
    finished: () => reply.finished(),
    get audioStarted() {
      return started;
    },
    onAudioStart: (listener) => {
      if (started) listener();
      else startListeners.push(listener);
    },
    progress: () => ({
      heard: pieces.filter((piece) => piece.state === 'played').map((piece) => piece.text),
      interrupted: pieces.find((piece) => piece.state === 'playing' || piece.state === 'cut')?.text,
      unsaid: pieces.filter((piece) => piece.state === 'waiting').map((piece) => piece.text),
    }),
  };
}
