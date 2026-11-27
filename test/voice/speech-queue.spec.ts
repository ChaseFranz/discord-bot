import { SpeechQueue, type AudioSink } from '../../src/voice/SpeechQueue.js';
import { settle, silentLogger } from '../helpers.js';

/** A sink where each play() lasts until finish() is called (or it's stopped). */
class FakeSink implements AudioSink<string> {
  readonly events: string[] = [];
  private finishCurrent: (() => void) | undefined;

  play(audio: string): Promise<void> {
    this.events.push(`play ${audio}`);
    return new Promise((resolve) => (this.finishCurrent = resolve));
  }
  stop(): void {
    this.events.push('stop');
    this.finish();
  }
  discard(audio: string): void {
    this.events.push(`discard ${audio}`);
  }
  pause(): void {
    this.events.push('pause');
  }
  resume(): void {
    this.events.push('resume');
  }
  finish(): void {
    const finish = this.finishCurrent;
    this.finishCurrent = undefined;
    finish?.();
  }
}

describe('SpeechQueue', () => {
  let sink: FakeSink;
  let queue: SpeechQueue<string>;
  let prepared: string[];
  let hooks: string[];

  /** A preparation step you resolve by hand, like a text-to-speech request in flight. */
  function deferred(name: string) {
    let resolve!: (value: string) => void;
    const promise = new Promise<string>((r) => (resolve = r));
    return { prepare: () => (prepared.push(name), promise), resolve: () => resolve(name) };
  }
  const instant = (name: string) => async () => (prepared.push(name), name);

  beforeEach(() => {
    sink = new FakeSink();
    prepared = [];
    hooks = [];
    queue = new SpeechQueue(sink, { started: () => hooks.push('started'), idle: () => hooks.push('idle') }, silentLogger());
  });

  it('plays in order and prepares the next piece while the current one plays', async () => {
    const reply = queue.openReply();
    const second = deferred('two');
    reply.add('one', instant('one'));
    reply.add('two', second.prepare);
    reply.add('three', instant('three'));
    await settle();
    expect(sink.events).toEqual(['play one']);
    expect(prepared).toEqual(['one', 'two']); // "three" waits until "two" is up next
    second.resolve();
    sink.finish();
    await settle();
    expect(sink.events).toEqual(['play one', 'play two']);
    expect(prepared).toEqual(['one', 'two', 'three']);
    sink.finish();
    await settle();
    sink.finish();
    await reply.finished();
    expect(sink.events).toEqual(['play one', 'play two', 'play three']);
    expect(hooks).toEqual(['started', 'idle']);
    expect(queue.busy).toBe(false);
  });

  it('cancels one reply without touching other speech', async () => {
    const reply = queue.openReply();
    reply.add('a1', instant('a1'));
    reply.add('a2', instant('a2'));
    const other = queue.enqueue('b', instant('b'));
    await settle();
    reply.cancel();
    await settle();
    expect(sink.events).toEqual(['play a1', 'stop', 'discard a2', 'play b']);
    expect(reply.cancelled).toBe(true);
    reply.add('a3', instant('a3')); // ignored
    sink.finish();
    await other;
    await reply.finished();
    expect(prepared).not.toContain('a3');
  });

  it('stops everything at once, even while speech is still being prepared', async () => {
    const slow = deferred('slow');
    const reply = queue.openReply();
    const done = queue.enqueue('slow', slow.prepare);
    reply.add('later', instant('later'));
    await settle();
    expect(queue.stopAll()).toBe(true);
    await done; // settled without waiting for the slow preparation
    expect(reply.cancelled).toBe(true);
    slow.resolve();
    await settle();
    expect(sink.events).toEqual(['discard later', 'discard slow']);
    // New speech after the stop plays normally.
    const after = queue.enqueue('after', instant('after'));
    await settle();
    expect(sink.events.at(-1)).toBe('play after');
    sink.finish();
    await after;
    expect(queue.stopAll()).toBe(false);
  });

  it('skips a piece whose preparation fails', async () => {
    const reply = queue.openReply();
    reply.add('bad', async () => {
      throw new Error('Polly said no');
    });
    reply.add('good', instant('good'));
    await settle();
    expect(sink.events).toEqual(['play good']);
    sink.finish();
    await reply.finished();
  });

  describe('pausing', () => {
    it('freezes the piece that is playing and carries on from there', async () => {
      const reply = queue.openReply();
      reply.add('one', instant('one'));
      reply.add('two', instant('two'));
      await settle();
      queue.pause();
      queue.pause(); // already paused: nothing more happens
      expect(queue.paused).toBe(true);
      expect(sink.events).toEqual(['play one', 'pause']);
      queue.resume();
      expect(sink.events).toEqual(['play one', 'pause', 'resume']);
      sink.finish();
      await settle();
      expect(sink.events).toEqual(['play one', 'pause', 'resume', 'play two']);
    });

    it('starts nothing new while paused, however ready it is', async () => {
      queue.pause();
      const reply = queue.openReply();
      reply.add('one', instant('one'));
      await settle();
      expect(sink.events).toEqual([]);
      expect(hooks).toEqual([]);
      expect(queue.busy).toBe(true);
      queue.resume();
      await settle();
      expect(sink.events).toEqual(['play one']);
      expect(hooks).toEqual(['started']);
    });

    it('can drop a paused reply and speak another in its place', async () => {
      const old = queue.openReply();
      old.add('old one', instant('old one'));
      old.add('old two', instant('old two'));
      await settle();
      queue.pause();
      old.cancel();
      const corrected = queue.openReply();
      corrected.add('new', instant('new'));
      await settle();
      expect(sink.events).toEqual(['play old one', 'pause', 'stop', 'discard old two']);
      queue.resume();
      await settle();
      expect(sink.events.at(-1)).toBe('play new');
    });

    it('ends the pause when everything is stopped', async () => {
      const reply = queue.openReply();
      reply.add('one', instant('one'));
      await settle();
      queue.pause();
      expect(queue.stopAll()).toBe(true);
      expect(queue.paused).toBe(false);
      void queue.enqueue('later', instant('later'));
      await settle();
      expect(sink.events).toEqual(['play one', 'pause', 'stop', 'play later']);
    });
  });

  it('reports what happened to each piece: played, cut off, or never played', async () => {
    const heard: string[] = [];
    const track = (name: string) => ({ started: () => heard.push(`${name} started`), ended: (how: string) => heard.push(`${name} ${how}`) });
    const reply = queue.openReply();
    reply.add('one', instant('one'), track('one'));
    reply.add('two', instant('two'), track('two'));
    reply.add('three', instant('three'), track('three'));
    await settle();
    sink.finish();
    await settle();
    expect(heard).toEqual(['one started', 'one played', 'two started']);
    reply.cancel();
    await settle();
    expect(heard).toEqual(['one started', 'one played', 'two started', 'three dropped', 'two cut']);
    reply.add('four', instant('four'), track('four'));
    expect(heard.at(-1)).toBe('four dropped');
  });

  it('plays an interjection next, ahead of what is waiting', async () => {
    const reply = queue.openReply();
    reply.add('one', instant('one'));
    reply.add('two', instant('two'));
    await settle();
    void queue.enqueueNext('ack', instant('ack'));
    void queue.enqueueNext('second ack', instant('second ack'));
    for (let clip = 0; clip < 3; clip++) {
      sink.finish();
      await settle();
    }
    // Interjections go ahead of what was waiting, in the order they were made.
    expect(sink.events).toEqual(['play one', 'play ack', 'play second ack', 'play two']);
  });
});
