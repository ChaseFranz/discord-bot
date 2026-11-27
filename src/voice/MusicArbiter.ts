import type { PlaybackState } from '../music/types.js';

export type PlayerStatus = 'idle' | 'buffering' | 'playing' | 'paused' | 'autopaused';

/** The parts of an audio player the arbiter controls. */
export interface PausablePlayer {
  readonly status: PlayerStatus;
  /** Returns false if there was nothing playing to pause. */
  pause(): boolean;
  /** Returns false if it wasn't paused. */
  unpause(): boolean;
}

/**
 * Decides when music pauses and resumes around the assistant.
 *
 * Music goes quiet while the assistant is talking, and while it's preparing a reply (a "hold",
 * taken when it hears its name). It comes back once both are over, unless someone paused the music
 * on purpose in the meantime. A resume request during that time is honoured once the assistant is done.
 */
export class MusicArbiter {
  private holds = 0;
  private speaking = false;
  /** Music is paused only because the assistant needed quiet, so it should come back afterwards. */
  private pausedForAssistant = false;

  constructor(private readonly player: PausablePlayer) {}

  get assistantActive(): boolean {
    return this.speaking || this.holds > 0;
  }

  /** Keeps music quiet until the returned function is called (calling it again does nothing). */
  hold(): () => void {
    this.holds++;
    this.quiet();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.maybeResume();
    };
  }

  speechStarted(): void {
    this.speaking = true;
    this.quiet();
  }

  speechEnded(): void {
    this.speaking = false;
    this.maybeResume();
  }

  /** Someone asked to pause the music. */
  userPause(): boolean {
    if (this.player.status === 'paused' && this.pausedForAssistant) {
      // Already silent for the assistant: just don't bring it back afterwards.
      this.pausedForAssistant = false;
      return true;
    }
    return this.player.pause();
  }

  /** Someone asked to resume the music. */
  userResume(): boolean {
    if (this.player.status !== 'paused') return false;
    if (this.assistantActive) {
      // Resume once the assistant has finished.
      this.pausedForAssistant = true;
      return true;
    }
    return this.player.unpause();
  }

  /** A track was stopped or a new one started: forget any pause taken for the old one. */
  trackChanged(): void {
    this.pausedForAssistant = false;
  }

  /** The state to show people: music held for the assistant still counts as playing. */
  reportedState(): PlaybackState {
    switch (this.player.status) {
      case 'idle':
        return 'idle';
      case 'buffering':
        return 'buffering';
      case 'playing':
      case 'autopaused':
        return 'playing';
      case 'paused':
        return this.pausedForAssistant ? 'playing' : 'paused';
    }
  }

  private quiet(): void {
    const status = this.player.status;
    if (!this.pausedForAssistant && (status === 'playing' || status === 'buffering') && this.player.pause()) {
      this.pausedForAssistant = true;
    }
  }

  private maybeResume(): void {
    if (this.assistantActive || !this.pausedForAssistant) return;
    this.pausedForAssistant = false;
    if (this.player.status === 'paused') this.player.unpause();
  }
}
