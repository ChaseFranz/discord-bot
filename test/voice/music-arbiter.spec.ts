import { MusicArbiter, type PausablePlayer, type PlayerStatus } from '../../src/voice/MusicArbiter.js';

class FakePlayer implements PausablePlayer {
  status: PlayerStatus = 'playing';
  pauses = 0;
  unpauses = 0;

  pause(): boolean {
    if (this.status !== 'playing') return false;
    this.status = 'paused';
    this.pauses++;
    return true;
  }

  unpause(): boolean {
    if (this.status !== 'paused') return false;
    this.status = 'playing';
    this.unpauses++;
    return true;
  }
}

describe('MusicArbiter', () => {
  let player: FakePlayer;
  let arbiter: MusicArbiter;

  beforeEach(() => {
    player = new FakePlayer();
    arbiter = new MusicArbiter(player);
  });

  it('keeps music quiet from the wake word through the reply, then resumes once', () => {
    const release = arbiter.hold();
    expect(player.status).toBe('paused');
    expect(arbiter.reportedState()).toBe('playing'); // only paused for the assistant

    arbiter.speechStarted(); // chime
    arbiter.speechEnded();
    expect(player.status).toBe('paused'); // still thinking: no blip of music between chime and reply
    arbiter.speechStarted(); // reply
    arbiter.speechEnded();
    expect(player.status).toBe('paused');

    release();
    release(); // releasing twice is harmless
    expect(player.status).toBe('playing');
    expect([player.pauses, player.unpauses]).toEqual([1, 1]);
  });

  it('waits for every hold and for speech to end', () => {
    const first = arbiter.hold();
    const second = arbiter.hold();
    arbiter.speechStarted();
    first();
    second();
    expect(player.status).toBe('paused');
    arbiter.speechEnded();
    expect(player.status).toBe('playing');
  });

  it('keeps a pause someone asked for while the assistant had the floor', () => {
    const release = arbiter.hold();
    expect(arbiter.userPause()).toBe(true); // "Nimbus, pause the music"
    expect(arbiter.reportedState()).toBe('paused');
    release();
    expect(player.status).toBe('paused');
  });

  it('resumes after the assistant when someone asks to resume mid-reply', () => {
    player.status = 'paused'; // paused by a person earlier
    const release = arbiter.hold();
    expect(arbiter.userResume()).toBe(true); // "Nimbus, resume the music"
    expect(player.status).toBe('paused'); // not over the reply
    release();
    expect(player.status).toBe('playing');
  });

  it('leaves music that was already paused alone', () => {
    player.status = 'paused';
    const release = arbiter.hold();
    release();
    expect(player.status).toBe('paused');
    expect(player.unpauses).toBe(0);
  });

  it('forgets a pause taken for a track that was skipped or stopped', () => {
    const release = arbiter.hold();
    arbiter.trackChanged(); // "Nimbus, skip this"
    player.status = 'playing'; // next track starts
    release();
    expect(player.unpauses).toBe(0);
    expect(player.status).toBe('playing');
  });

  it('acts on a resume immediately when the assistant is idle', () => {
    expect(arbiter.userResume()).toBe(false); // nothing paused
    player.pause();
    expect(arbiter.userResume()).toBe(true);
    expect(player.status).toBe('playing');
  });
});
