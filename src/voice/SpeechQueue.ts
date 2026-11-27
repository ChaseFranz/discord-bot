import type { Logger } from '../logging/logger.js';
import { describeError } from '../logging/logger.js';

/** Where queued audio is played. */
export interface AudioSink<A> {
  /** Plays `audio`, resolving when it finishes or is stopped. */
  play(audio: A): Promise<void>;
  /** Stops whatever is playing now (play() then resolves). */
  stop(): void;
  /** Releases audio that will never be played. */
  discard(audio: A): void;
  /** Freezes what is playing mid-word; play() stays pending until resume() or stop(). */
  pause(): void;
  resume(): void;
}

export interface SpeechQueueHooks {
  /** Before the first item plays after the queue was idle. */
  started(): void;
  /** After the last queued item has finished and nothing else is waiting. */
  idle(): void;
}

/** How a piece of speech ended: heard in full, cut off while playing, or never played. */
export type PieceEnding = 'played' | 'cut' | 'dropped';

/** Told what happens to one piece, so the caller knows what has actually been heard. */
export interface PieceHooks {
  /** The piece has started playing. */
  started?(): void;
  ended?(how: PieceEnding): void;
}

/**
 * One reply being spoken piece by piece (sentence by sentence while the model is still writing).
 * Cancelling it drops only its own pieces; other queued speech keeps playing.
 */
export interface SpokenReply {
  /** Queues another piece. Ignored once the reply is cancelled. */
  add(label: string, prepare: () => Promise<unknown>, hooks?: PieceHooks): void;
  /** Stops this reply now and drops the rest of it. */
  cancel(): void;
  readonly cancelled: boolean;
  /** Resolves when every piece added so far has played (or been dropped). */
  finished(): Promise<void>;
}

interface Owner {
  cancelled: boolean;
  /** The queue generation when the reply was opened; stopAll() ends the reply too. */
  generation: number;
}

interface Item<A> {
  label: string;
  prepare: () => Promise<A>;
  /** Started ahead of time so the next piece is ready the moment the current one ends. */
  prepared?: Promise<A | undefined>;
  owner: Owner | undefined;
  hooks: PieceHooks | undefined;
  generation: number;
  /** Stopped while it was playing. */
  cut: boolean;
  /** Queued to play next, ahead of ordinary items. */
  next: boolean;
  settle: () => void;
  done: Promise<void>;
}

const INTERRUPTED = Symbol('interrupted');
/** Pieces prepared ahead: the one about to play and the one after it. */
const PREFETCH = 2;

/**
 * Plays prepared audio (synthesised speech, chimes) one item at a time, in order. While an item
 * plays, the next one is already being prepared, so consecutive sentences follow without a gap.
 * stopAll() and SpokenReply.cancel() take effect immediately, even while an item is still being
 * prepared. pause() freezes everything where it is, mid-word, until resume().
 */
export class SpeechQueue<A> {
  private readonly items: Array<Item<A>> = [];
  private current: Item<A> | undefined;
  private playing = false;
  private active = false;
  private pumping = false;
  private held = false;
  private generation = 0;
  private interruptCurrent: (() => void) | undefined;
  /** Wakes an item that is ready to play but waiting for resume(). */
  private wake: (() => void) | undefined;

  constructor(
    private readonly sink: AudioSink<A>,
    private readonly hooks: SpeechQueueHooks,
    private readonly logger: Logger,
  ) {}

  /** True while anything is playing, being prepared or waiting. */
  get busy(): boolean {
    return this.current !== undefined || this.items.length > 0;
  }

  get paused(): boolean {
    return this.held;
  }

  /** Queues one item; resolves when it has played (or was dropped). */
  enqueue(label: string, prepare: () => Promise<A>, hooks?: PieceHooks): Promise<void> {
    return this.push(label, prepare, undefined, hooks, false);
  }

  /**
   * Queues one item to play next, ahead of everything already waiting (a short interjection).
   * Several of these play in the order they were queued.
   */
  enqueueNext(label: string, prepare: () => Promise<A>, hooks?: PieceHooks): Promise<void> {
    return this.push(label, prepare, undefined, hooks, true);
  }

  openReply(): SpokenReply {
    const owner: Owner = { cancelled: false, generation: this.generation };
    const pieces: Array<Promise<void>> = [];
    const ended = () => owner.cancelled || owner.generation !== this.generation;
    return {
      add: (label, prepare, hooks) => {
        if (ended()) {
          hooks?.ended?.('dropped');
          return;
        }
        pieces.push(this.push(label, prepare as () => Promise<A>, owner, hooks, false));
      },
      cancel: () => {
        if (owner.cancelled) return;
        owner.cancelled = true;
        this.dropQueued((item) => item.owner === owner);
        if (this.current?.owner === owner) this.stopCurrent();
      },
      get cancelled() {
        return ended();
      },
      finished: async () => {
        await Promise.all([...pieces]);
      },
    };
  }

  /** Stops what's playing and drops everything queued (a pause ends too). Returns whether anything was. */
  stopAll(): boolean {
    const wasBusy = this.busy;
    this.generation++;
    this.held = false;
    this.dropQueued(() => true);
    if (this.current) this.stopCurrent();
    return wasBusy;
  }

  /** Freezes speech where it is: the current piece stops mid-word and nothing new starts. */
  pause(): void {
    if (this.held) return;
    this.held = true;
    if (this.playing) this.sink.pause();
  }

  /** Carries on from where pause() froze things. */
  resume(): void {
    if (!this.held) return;
    this.held = false;
    if (this.playing) this.sink.resume();
    this.wake?.();
  }

  private push(
    label: string,
    prepare: () => Promise<A>,
    owner: Owner | undefined,
    hooks: PieceHooks | undefined,
    next: boolean,
  ): Promise<void> {
    let settle!: () => void;
    const done = new Promise<void>((resolve) => (settle = resolve));
    const item: Item<A> = { label, prepare, owner, hooks, generation: this.generation, cut: false, next, settle, done };
    if (next) {
      const ahead = this.items.findIndex((waiting) => !waiting.next);
      this.items.splice(ahead < 0 ? this.items.length : ahead, 0, item);
    } else {
      this.items.push(item);
    }
    this.prefetch();
    void this.pump();
    return done;
  }

  private cancelled(item: Item<A>): boolean {
    return item.generation !== this.generation || item.owner?.cancelled === true;
  }

  private prefetch(): void {
    const ahead = this.current ? PREFETCH - 1 : PREFETCH;
    for (const item of this.items.slice(0, ahead)) this.start(item);
  }

  private start(item: Item<A>): Promise<A | undefined> {
    item.prepared ??= item.prepare().catch((error: unknown) => {
      this.logger.warn(`Could not prepare ${item.label}: ${describeError(error)}`);
      return undefined;
    });
    return item.prepared;
  }

  private dropQueued(predicate: (item: Item<A>) => boolean): void {
    for (let index = this.items.length - 1; index >= 0; index--) {
      const item = this.items[index]!;
      if (!predicate(item)) continue;
      this.items.splice(index, 1);
      this.release(item);
    }
  }

  /** Settles an item that will not be played, discarding its audio if preparation already started. */
  private release(item: Item<A>): void {
    void item.prepared?.then((audio) => {
      if (audio !== undefined) this.sink.discard(audio);
    });
    this.tell(item, 'dropped');
    item.settle();
  }

  private tell(item: Item<A>, how: PieceEnding | 'started'): void {
    try {
      if (how === 'started') item.hooks?.started?.();
      else item.hooks?.ended?.(how);
    } catch (error) {
      this.logger.warn(`A listener for ${item.label} failed: ${describeError(error)}`);
    }
  }

  private stopCurrent(): void {
    if (this.playing) {
      if (this.current) this.current.cut = true;
      this.sink.stop();
    } else {
      this.interruptCurrent?.();
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let item = this.items.shift(); item; item = this.items.shift()) {
        this.current = item;
        try {
          await this.playItem(item);
        } finally {
          this.current = undefined;
          item.settle();
        }
      }
    } finally {
      this.pumping = false;
      if (this.active) {
        this.active = false;
        this.hooks.idle();
      }
    }
  }

  private async playItem(item: Item<A>): Promise<void> {
    if (this.cancelled(item)) {
      this.release(item);
      return;
    }
    const prepared = this.start(item);
    this.prefetch();
    const audio = await new Promise<A | undefined | typeof INTERRUPTED>((resolve) => {
      this.interruptCurrent = () => resolve(INTERRUPTED);
      void prepared.then(resolve);
    });
    this.interruptCurrent = undefined;
    if (audio === INTERRUPTED || this.cancelled(item)) {
      this.release(item);
      return;
    }
    if (audio === undefined) {
      this.tell(item, 'dropped');
      return;
    }

    // Paused: the piece waits here, ready, until resume() (or until it's cancelled).
    if (this.held) {
      const interrupted = await new Promise<boolean>((resolve) => {
        this.wake = () => resolve(false);
        this.interruptCurrent = () => resolve(true);
      });
      this.wake = undefined;
      this.interruptCurrent = undefined;
      if (interrupted || this.cancelled(item)) {
        this.release(item);
        return;
      }
    }

    if (!this.active) {
      this.active = true;
      this.hooks.started();
    }
    this.playing = true;
    this.tell(item, 'started');
    try {
      await this.sink.play(audio);
    } catch (error) {
      this.logger.warn(`Could not play ${item.label}: ${describeError(error)}`);
    } finally {
      this.playing = false;
    }
    this.tell(item, item.cut ? 'cut' : 'played');
  }
}
