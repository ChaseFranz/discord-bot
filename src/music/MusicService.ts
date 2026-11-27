import type { Logger } from '../logging/logger.js';
import { describeError } from '../logging/logger.js';
import { MusicError, type MusicHost, type MusicOutput, type MusicStatus, type Track, type TrackSource } from './types.js';

interface GuildQueue {
  output: MusicOutput;
  /** tracks[0] is the one playing (or about to). */
  tracks: Track[];
  unsubscribe: Array<() => void>;
}

/** Per-guild music queues. Used by both the slash commands and the assistant's music tools. */
export class MusicService {
  private readonly queues = new Map<string, GuildQueue>();

  constructor(
    private readonly host: MusicHost,
    private readonly source: TrackSource,
    private readonly logger: Logger,
  ) {}

  /** Queues a track (URL or search). Returns the track and its position: 0 means it starts now. */
  async play(guildId: string, voiceChannelId: string, query: string, requestedBy?: string): Promise<{ track: Track; position: number }> {
    const resolved = await this.source.resolve(query);
    if (!resolved) throw new MusicError(`No results found for "${query}".`);
    const track: Track = { ...resolved, requestedBy };

    let output: MusicOutput;
    try {
      output = await this.host.ensureOutput(guildId, voiceChannelId);
    } catch (error) {
      // It never made it into a queue.
      this.discard(track);
      throw error;
    }
    let queue = this.queues.get(guildId);
    if (!queue || queue.output !== output) {
      if (queue) this.dispose(guildId, queue);
      queue = this.createQueue(guildId, output);
    }

    queue.tracks.push(track);
    const position = queue.tracks.length - 1;
    if (position === 0) {
      await this.startCurrent(guildId, queue);
    }
    return { track, position };
  }

  skip(guildId: string): Track {
    const queue = this.requireQueue(guildId);
    const skipped = queue.tracks[0];
    if (!skipped) throw new MusicError('There is no song playing.');
    // Stopping fires the idle event, which advances the queue.
    queue.output.stop();
    return skipped;
  }

  pause(guildId: string): Track {
    const queue = this.requireQueue(guildId);
    if (queue.output.state === 'paused') throw new MusicError('The music is already paused.');
    if (!queue.output.pause()) throw new MusicError('Nothing is playing right now.');
    return queue.tracks[0]!;
  }

  resume(guildId: string): Track {
    const queue = this.requireQueue(guildId);
    if (queue.output.state !== 'paused') throw new MusicError('The music is not paused.');
    if (!queue.output.resume()) throw new MusicError('Could not resume the music, please try again.');
    return queue.tracks[0]!;
  }

  stop(guildId: string): number {
    const queue = this.requireQueue(guildId);
    const cleared = queue.tracks.length;
    this.dispose(guildId, queue);
    queue.output.stop();
    this.host.queueFinished(guildId);
    return cleared;
  }

  status(guildId: string): MusicStatus {
    const queue = this.queues.get(guildId);
    if (!queue || queue.tracks.length === 0) return { state: 'idle', current: undefined, upcoming: [] };
    return { state: queue.output.state, current: queue.tracks[0], upcoming: queue.tracks.slice(1) };
  }

  /** One-line description of what's playing, for the assistant's situation note. */
  describe(guildId: string): string {
    const { state, current, upcoming } = this.status(guildId);
    if (!current) return 'nothing playing';
    const more = upcoming.length > 0 ? ` (${upcoming.length} more queued)` : '';
    return `${state === 'paused' ? 'paused' : 'playing'} "${current.title}"${more}`;
  }

  /** Called by the host when the guild's voice connection goes away. */
  detach(guildId: string): void {
    const queue = this.queues.get(guildId);
    if (queue) this.dispose(guildId, queue);
  }

  private createQueue(guildId: string, output: MusicOutput): GuildQueue {
    const queue: GuildQueue = { output, tracks: [], unsubscribe: [] };
    queue.unsubscribe.push(
      output.onIdle(() => void this.advance(guildId, queue)),
      output.onError((error) => this.logger.warn(`Music playback error in guild ${guildId}: ${describeError(error)}`)),
    );
    this.queues.set(guildId, queue);
    return queue;
  }

  private async advance(guildId: string, queue: GuildQueue): Promise<void> {
    if (this.queues.get(guildId) !== queue) return;
    const over = queue.tracks.shift();
    if (over) this.discard(over);
    if (queue.tracks.length > 0) {
      await this.startCurrent(guildId, queue);
    } else {
      this.dispose(guildId, queue);
      this.host.queueFinished(guildId);
    }
  }

  private async startCurrent(guildId: string, queue: GuildQueue): Promise<void> {
    // Skip over tracks whose stream can't be opened instead of stalling the queue.
    while (queue.tracks.length > 0 && this.queues.get(guildId) === queue) {
      const track = queue.tracks[0]!;
      try {
        const stream = await this.source.open(track);
        if (this.queues.get(guildId) !== queue) {
          stream.destroy();
          return;
        }
        queue.output.play(stream);
        return;
      } catch (error) {
        this.logger.warn(`Could not open "${track.title}" (${track.url}): ${describeError(error)}`);
        queue.tracks.shift();
        this.discard(track);
      }
    }
    if (this.queues.get(guildId) === queue && queue.tracks.length === 0) {
      this.dispose(guildId, queue);
      this.host.queueFinished(guildId);
    }
  }

  private requireQueue(guildId: string): GuildQueue {
    const queue = this.queues.get(guildId);
    if (!queue || queue.tracks.length === 0) throw new MusicError('There is no song playing.');
    return queue;
  }

  private dispose(guildId: string, queue: GuildQueue): void {
    for (const unsubscribe of queue.unsubscribe) unsubscribe();
    queue.unsubscribe = [];
    for (const track of queue.tracks) this.discard(track);
    queue.tracks = [];
    if (this.queues.get(guildId) === queue) this.queues.delete(guildId);
  }

  /** Tells the source a track has left the queue, so whatever it is still preparing for it can stop. */
  private discard(track: Track): void {
    if (!this.source.discard) return;
    void Promise.resolve()
      .then(() => this.source.discard?.(track))
      .catch((error: unknown) => this.logger.warn(`Could not let go of "${track.title}": ${describeError(error)}`));
  }
}
