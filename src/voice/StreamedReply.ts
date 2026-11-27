import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import prism from 'prism-media';
import type { Logger } from '../logging/logger.js';
import { describeError } from '../logging/logger.js';
import type { SpeechStream } from '../speech/ports.js';
import type { ReplyVoice } from './ReplySpeech.js';

/** Each Opus packet Polly sends is 20 ms of audio. */
const FRAME_SECONDS = 0.02;
/** Seconds of speech per character, to start with: about right for Polly's generative voices. It is learned as a reply goes on. */
const SECONDS_PER_CHARACTER = 0.05;
/** A sentence's end is looked for only after this share of the time it should take, so a comma pause early on doesn't count. */
const EARLIEST_END = 0.6;
/** A pause this long after that is where it ends. (Sentences end in 350 ms or more; commas pause for less.) */
const SENTENCE_PAUSE_FRAMES = 15;
/** Without such a pause by this share of the time it should take, the longest pause there was is where it ends. */
const LATEST_END = 1.6;
/** Quieter than this is a pause: about -45 dBFS, where speech is around -24. */
const QUIET_LEVEL = 0.0056;
/** Packets in hand before a piece starts playing, so it doesn't stumble at the start. */
const HEAD_FRAMES = 6;
/** When no new piece comes for this long, Polly is asked to speak what it has instead of waiting to see what follows. */
const STALL_MS = 300;
/** A piece's stream asks for more when it holds fewer packets than this (80 ms): it is about to run out. */
const LOW_WATER_FRAMES = 4;

export interface StreamedReplyOptions<A> {
  /** Wraps a piece's audio, a stream of Opus packets, as the speech queue plays it. */
  wrap(packets: Readable): A;
  /** A piece's audio made on its own, for when the stream lets the reply down. */
  fallback(text: string): Promise<A>;
  logger: Logger;
  /** Told when a piece's text goes to be spoken (it is billed from then). */
  sent?(text: string): void;
  /** Told once the reply's stream is over, however it ended. */
  closed?(): void;
  /** Replaced in tests. */
  packetsOf?(audio: Readable): Readable;
  levelOf?(packet: Buffer): number;
  stallMs?: number;
}

interface Piece<A> {
  text: string;
  /** The first packet of its audio. */
  start: number | undefined;
  out: Readable | undefined;
  given: number;
  audio: Promise<A>;
  resolve(audio: A): void;
  reject(error: unknown): void;
  settled: boolean;
  closed: boolean;
  /** Its stream is about to run out, and an end has to be found now with what has arrived. */
  hungry: boolean;
}

/**
 * A reply spoken through one speech stream, so its sentences flow into one another, while still
 * being played, paused and kept track of piece by piece like any other (see ReplySpeech).
 *
 * The stream's audio has nothing in it to say where one sentence ends and the next begins. So each
 * piece's end is found in the audio: the speaking rate says roughly when it should come, and the
 * first proper pause from a little before then is taken as the place. A piece is always cut in a
 * pause or at the quietest point there is, so a misjudged end can only shift what counts as heard
 * by a phrase; nothing is clipped.
 *
 * The first piece is spoken at once (flushed), as quickly as a sentence asked for on its own. The
 * rest are written as they come and Polly is left to choose its moment, which makes for better
 * phrasing; when nothing more comes for a moment it is asked to speak what it has.
 *
 * If the stream fails, the pieces not yet heard are made one at a time instead (`fallback`).
 */
export class StreamedReply<A> implements ReplyVoice<A> {
  private readonly pieces: Array<Piece<A>> = [];
  private readonly packets: Array<Buffer | undefined> = [];
  private readonly levels: number[] = [];
  private readonly levelOf: (packet: Buffer) => number;
  /** Packets handed to pieces so far. */
  private assigned = 0;
  /** The piece being given audio. */
  private current = 0;
  private rate = SECONDS_PER_CHARACTER;
  /** The last piece Polly has been asked to speak without waiting. */
  private flushedThrough = -1;
  private stallTimer: NodeJS.Timeout | undefined;
  private ended = false;
  private audioDone = false;
  private failed = false;
  private cancelled = false;
  private advancing = false;
  private again = false;

  constructor(
    private readonly stream: SpeechStream,
    private readonly options: StreamedReplyOptions<A>,
  ) {
    this.levelOf = options.levelOf ?? levelOfPacket();
    const packets = options.packetsOf ? options.packetsOf(stream.audio) : stream.audio.pipe(new prism.opus.OggDemuxer());
    stream.audio.on('error', (error) => this.fail(error));
    packets.on('error', (error) => this.fail(error));
    packets.on('data', (packet: Buffer) => this.received(packet));
    packets.on('end', () => {
      if (this.failed || this.cancelled) return;
      this.audioDone = true;
      this.advance();
      this.finishIfDone();
    });
  }

  /** A piece of the reply has been written: it goes to Polly now, and its audio comes when its turn does. */
  piece(text: string): () => Promise<A> {
    let resolve!: (audio: A) => void;
    let reject!: (error: unknown) => void;
    const audio = new Promise<A>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    const piece: Piece<A> = { text, start: undefined, out: undefined, given: 0, audio, resolve, reject, settled: false, closed: false, hungry: false };
    const index = this.pieces.push(piece) - 1;
    if (this.cancelled) {
      this.settle(piece, Readable.from([]));
    } else if (this.failed || this.ended) {
      this.fallBack(piece);
    } else {
      // The first is spoken at once; later ones wait to see what follows them, for better phrasing.
      const first = index === 0;
      this.stream.write(first ? text : ` ${text}`, first);
      if (first) this.flushedThrough = 0;
      this.options.sent?.(text);
      this.waitForMore();
      this.advance();
    }
    return () => piece.audio;
  }

  /** No more pieces: what is left is spoken, and the last piece ends with the stream. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.stallTimer);
    if (!this.failed && !this.cancelled) this.stream.end();
    this.advance();
    this.finishIfDone();
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    clearTimeout(this.stallTimer);
    this.stream.abort();
    for (const piece of this.pieces) {
      piece.out?.destroy();
      if (!piece.settled) this.settle(piece, Readable.from([]));
    }
    this.options.closed?.();
  }

  // ---------------------------------------------------------------------------

  /** If no new piece comes for a moment (it is looking something up, say), Polly speaks what it has. */
  private waitForMore(): void {
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      if (this.ended || this.failed || this.cancelled || this.flushedThrough >= this.pieces.length - 1) return;
      this.stream.write('', true);
      this.flushedThrough = this.pieces.length - 1;
    }, this.options.stallMs ?? STALL_MS);
    this.stallTimer.unref?.();
  }

  private received(packet: Buffer): void {
    if (this.cancelled || this.failed) return;
    this.packets.push(packet);
    this.levels.push(this.levelOf(packet));
    this.advance();
  }

  /** Hands out the audio that has arrived to the pieces it belongs to, as far as that can be told yet. */
  private advance(): void {
    if (this.advancing) {
      // A piece's stream asked for more while audio was being handed out: go round again after.
      this.again = true;
      return;
    }
    this.advancing = true;
    try {
      do {
        this.again = false;
        this.step();
      } while (this.again);
    } finally {
      this.advancing = false;
    }
  }

  private step(): void {
    while (!this.cancelled && !this.failed && this.current < this.pieces.length) {
      const piece = this.pieces[this.current]!;
      piece.start ??= this.assigned;
      const last = this.current === this.pieces.length - 1;
      let end: { at: number; paused: boolean } | undefined;
      if (last) {
        // Nothing has been written after it: whatever has arrived is its.
        this.give(piece, this.packets.length);
        if (!(this.ended && this.audioDone)) return;
        end = { at: this.packets.length, paused: false };
      } else {
        end = this.findEnd(piece);
        if (!end) return;
      }
      this.give(piece, end.at);
      this.close(piece);
      if (end.paused) this.learnRate(piece, end.at);
      this.current++;
    }
  }

  /** Where `piece` ends, if that can be told from what has arrived (see the class comment). */
  private findEnd(piece: Piece<A>): { at: number; paused: boolean } | undefined {
    const start = piece.start!;
    const expected = (this.rate * Math.max(1, piece.text.length)) / FRAME_SECONDS;
    const from = Math.max(this.assigned, start + Math.floor(EARLIEST_END * expected));
    // Up to there it is certainly this piece's, and can be played already.
    this.give(piece, Math.min(from, this.packets.length));
    const received = this.packets.length;
    if (received <= from) return this.audioDone ? { at: received, paused: false } : undefined;

    let run = -1;
    for (let frame = from; frame < received; frame++) {
      if (this.levels[frame]! >= QUIET_LEVEL) {
        run = -1;
        continue;
      }
      if (run < 0) run = frame;
      if (frame - run + 1 >= SENTENCE_PAUSE_FRAMES) return { at: run + Math.floor(SENTENCE_PAUSE_FRAMES / 2), paused: true };
    }
    const latest = start + Math.ceil(LATEST_END * expected) + SENTENCE_PAUSE_FRAMES;
    // Wait for more, unless there won't be any, there has been enough, or what it has is about to run out.
    if (received < latest && !this.audioDone && !piece.hungry) return undefined;
    return { at: this.bestBreak(from, received), paused: false };
  }

  /** The middle of the longest pause in [from, to), or the quietest moment if there is no pause at all. */
  private bestBreak(from: number, to: number): number {
    let best = { start: -1, length: 0 };
    let quietest = from;
    for (let frame = from, run = -1; frame < to; frame++) {
      if (this.levels[frame]! < this.levels[quietest]!) quietest = frame;
      if (this.levels[frame]! >= QUIET_LEVEL) {
        run = -1;
        continue;
      }
      if (run < 0) run = frame;
      if (frame - run + 1 > best.length) best = { start: run, length: frame - run + 1 };
    }
    return best.length > 0 ? best.start + Math.floor(best.length / 2) : quietest;
  }

  /** What the reply's own pauses say about how fast this voice speaks it. */
  private learnRate(piece: Piece<A>, end: number): void {
    const actual = ((end - piece.start!) * FRAME_SECONDS) / Math.max(1, piece.text.length);
    this.rate = Math.min(0.09, Math.max(0.03, (this.rate + actual) / 2));
  }

  private open(piece: Piece<A>): Readable {
    piece.out ??= new Readable({
      objectMode: true,
      highWaterMark: LOW_WATER_FRAMES,
      read: () => {
        if (piece.closed) return;
        piece.hungry = true;
        this.advance();
      },
    });
    return piece.out;
  }

  private give(piece: Piece<A>, upTo: number): void {
    const out = this.open(piece);
    for (; this.assigned < upTo; this.assigned++) {
      out.push(this.packets[this.assigned]);
      // Played, or about to be: only its level is still needed.
      this.packets[this.assigned] = undefined;
      piece.given++;
      piece.hungry = false;
    }
    if (piece.given >= HEAD_FRAMES) this.settle(piece, out);
  }

  private close(piece: Piece<A>): void {
    if (piece.closed) return;
    piece.closed = true;
    const out = this.open(piece);
    out.push(null);
    this.settle(piece, out);
  }

  private settle(piece: Piece<A>, packets: Readable): void {
    if (piece.settled) return;
    piece.settled = true;
    piece.resolve(this.options.wrap(packets));
  }

  private fallBack(piece: Piece<A>): void {
    if (piece.settled) return;
    piece.settled = true;
    piece.out?.destroy();
    this.options.fallback(piece.text).then(piece.resolve, piece.reject);
  }

  /** The stream let the reply down: what is under way ends where it is, and the rest is made a piece at a time. */
  private fail(error: unknown): void {
    if (this.failed || this.cancelled || this.audioDone) return;
    this.failed = true;
    clearTimeout(this.stallTimer);
    const waiting = this.pieces.slice(this.current);
    if (waiting.length > 0) this.options.logger.warn(`Polly's speech stream failed, so the rest of this reply is spoken a sentence at a time: ${describeError(error)}`);
    for (const piece of waiting) {
      if (piece.given > 0) this.close(piece);
      else this.fallBack(piece);
    }
    this.current = this.pieces.length;
    this.options.closed?.();
  }

  private finishIfDone(): void {
    if (this.ended && this.audioDone && this.current >= this.pieces.length && !this.failed && !this.cancelled) this.options.closed?.();
  }
}

/** How loud a 20 ms Opus packet is (its RMS, from 0 to 1), decoding it the way a listener would. */
function levelOfPacket(): (packet: Buffer) => number {
  const { OpusEncoder } = createRequire(import.meta.url)('@discordjs/opus') as {
    OpusEncoder: new (rate: number, channels: number) => { decode(packet: Buffer): Buffer };
  };
  const decoder = new OpusEncoder(48_000, 1);
  return (packet) => {
    try {
      const pcm = decoder.decode(packet);
      let sum = 0;
      for (let offset = 0; offset + 1 < pcm.length; offset += 2) sum += pcm.readInt16LE(offset) ** 2;
      return Math.sqrt(sum / Math.max(1, pcm.length / 2)) / 32_768;
    } catch {
      // Can't be read: count it as sound, so nothing is ever cut there.
      return 1;
    }
  };
}
