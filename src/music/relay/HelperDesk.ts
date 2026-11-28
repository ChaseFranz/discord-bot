import type { Clock } from '../../util/time.js';
import type { AudioRelayStore, HelperRegistration, HelperRegistry, MusicJobBoard } from './ports.js';
import { formatSetupCode, hashSecret, newSecret } from './tokens.js';

/** How often a helper asks whether there is anything to fetch while the bot is in a call, or on its way to one. */
export const HELPER_POLL_MS = 2_000;
/**
 * How often it asks the rest of the time. Songs are only asked for in calls, and a call takes
 * longer than this to get going (the voice task is started when someone asks for it, and is about
 * half a minute from playing anything), so helpers are asking often again before a song is wanted.
 */
export const HELPER_IDLE_POLL_MS = 15_000;
/** A helper's check-ins are written down at most this often (each one is a database write). */
export const CHECK_IN_EVERY_MS = 10_000;
/**
 * A helper counts as running if it checked in this recently. Long enough for a poll that failed
 * while it was idle: the helper then waits twice as long, up to 30 seconds, before the next one.
 */
export const HELPER_ONLINE_MS = 60_000;
/** How often the bot says it is still listening to a live stream it is playing. */
export const LISTENING_EVERY_MS = 20_000;
/**
 * A live stream nobody has listened to for this long is stopped: its helper is told so at its next
 * report. Long enough to cover a few missed check-ins; short enough that a stream left behind by a
 * call that ended badly doesn't go on using someone's connection.
 */
export const UNHEARD_MS = 90_000;

export interface HelperDeskDeps {
  guildId: string;
  registry: HelperRegistry;
  clock: Clock;
  /** The public address helpers talk to (see HelperApi). */
  apiUrl: string;
  /** Where the helper and its instructions can be downloaded. */
  guideUrl: string;
  /** Where the helper's files are, its installers (install.ps1 and install.sh) among them. */
  downloadUrl: string;
}

/** The bot's view of music helpers: who is running one, and handing out the codes to set one up. */
export class HelperDesk {
  constructor(private readonly deps: HelperDeskDeps) {}

  get guideUrl(): string {
    return this.deps.guideUrl;
  }

  get downloadUrl(): string {
    return this.deps.downloadUrl;
  }

  /** People whose helper is running right now, the most recently heard from first. */
  async online(): Promise<HelperRegistration[]> {
    const since = this.deps.clock() - HELPER_ONLINE_MS;
    return (await this.deps.registry.list(this.deps.guildId))
      .filter((registration) => registration.lastSeenAt !== null && registration.lastSeenAt >= since)
      .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  }

  registration(userId: string): Promise<HelperRegistration | undefined> {
    return this.deps.registry.find(this.deps.guildId, userId);
  }

  /**
   * Registers the person and returns the code they paste into the helper. Any code they had before
   * stops working: only a hash of the secret is kept, so an old code can't be shown again.
   */
  async issue(userId: string, userName: string): Promise<string> {
    const secret = newSecret();
    await this.deps.registry.register({
      guildId: this.deps.guildId,
      userId,
      userName,
      secretHash: hashSecret(secret),
      createdAt: this.deps.clock(),
    });
    return formatSetupCode(this.deps.apiUrl, { guildId: this.deps.guildId, userId, secret });
  }

  remove(userId: string): Promise<boolean> {
    return this.deps.registry.remove(this.deps.guildId, userId);
  }

  /** Why music can't be fetched right now (nobody is running a helper), or undefined when someone is. */
  async blocker(): Promise<string | undefined> {
    return (await this.online()).length > 0 ? undefined : noHelperMessage(this.deps.guideUrl);
  }
}

/** Everything the bot needs to have music fetched by helpers. */
export interface MusicRelay {
  desk: HelperDesk;
  registry: HelperRegistry;
  board: MusicJobBoard;
  store: AudioRelayStore;
}

export function noHelperMessage(guideUrl: string): string {
  return (
    "Music needs a helper right now, and nobody's is running. YouTube won't send audio to the servers I run on, " +
    'so someone in the server has to run the Nimbus music helper on their own computer. ' +
    `\`/musichelper\` gets you set up in a couple of minutes: ${guideUrl}`
  );
}
