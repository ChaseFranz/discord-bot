import type { APIChatInputApplicationCommandGuildInteraction } from 'discord-api-types/v10';
import type { CallInfo, CommandContext } from '../discord/context.js';
import type { BotCommand } from '../discord/types.js';
import type { Logger } from '../logging/logger.js';
import { describeError } from '../logging/logger.js';
import type { Clock } from '../util/time.js';

/**
 * On AWS, calls are handled by a voice task (a Fargate container) that runs only while the bot is
 * in a call. Lambda answers every slash command; voice commands are passed to the task through a
 * queue, and /join or /play start it first when it isn't running. The task reports in to a status
 * record, which tells Lambda whether it's up and who is in the call.
 */

/** A voice task that hasn't reported in for this long is treated as gone. */
export const HEARTBEAT_STALE_MS = 90_000;
/** A task that was asked to start but never reported in is treated as gone after this. */
export const START_TIMEOUT_MS = 3 * 60_000;

export interface CallSnapshot {
  channelId: string;
  channelName: string;
  people: Array<{ id: string; name: string }>;
  /** What music is doing, e.g. 'playing "Song"' or 'nothing playing'. */
  music: string;
}

export interface VoiceTaskRecord {
  guildId: string;
  status: 'starting' | 'running';
  /** When the start was requested. */
  startedAt: number;
  /** When the task last reported in. */
  heartbeatAt: number;
  taskArn?: string;
  /** The call the bot is in, if any. */
  call?: CallSnapshot;
}

export interface VoiceTaskStore {
  get(guildId: string): Promise<VoiceTaskRecord | undefined>;
  /**
   * Records that a task is starting, unless a live one is already recorded (two /joins at once
   * must not start two tasks). Returns whether this caller should start it.
   */
  claimStart(guildId: string, now: number): Promise<boolean>;
  /** Reports in: running, with the current call. */
  heartbeat(guildId: string, now: number, call: CallSnapshot | undefined): Promise<void>;
  setTaskArn(guildId: string, taskArn: string): Promise<void>;
  clear(guildId: string): Promise<void>;
}

export function isLive(record: VoiceTaskRecord | undefined, now: number): record is VoiceTaskRecord {
  if (!record) return false;
  return record.status === 'running' ? now - record.heartbeatAt < HEARTBEAT_STALE_MS : now - record.startedAt < START_TIMEOUT_MS;
}

export type VoiceTaskMessage =
  | { kind: 'interaction'; interaction: APIChatInputApplicationCommandGuildInteraction; sentAt: number }
  | { kind: 'announce'; guildId: string; text: string; sentAt: number };

export interface ReceivedMessage {
  message: VoiceTaskMessage;
  /** Pass to delete() once handled. */
  receipt: string;
}

/** Orders for the voice task (an SQS FIFO queue on AWS). */
export interface VoiceTaskQueue {
  send(message: VoiceTaskMessage): Promise<void>;
  /** Waits up to `waitSeconds` for messages; resolves early with [] when `signal` aborts. */
  receive(waitSeconds: number, signal?: AbortSignal): Promise<ReceivedMessage[]>;
  delete(receipt: string): Promise<void>;
}

/** Starts a voice task (ECS RunTask on AWS). Resolves to its id. */
export interface VoiceTaskLauncher {
  start(): Promise<string>;
}

/** Lambda's side: hands voice commands to the voice task, starting it when needed. */
export class VoiceTaskControl {
  constructor(
    private readonly deps: {
      store: VoiceTaskStore;
      queue: VoiceTaskQueue;
      launcher: VoiceTaskLauncher;
      calls: CallInfo;
      clock: Clock;
      logger: Logger;
    },
  ) {}

  async dispatch(command: BotCommand, interaction: APIChatInputApplicationCommandGuildInteraction, context: CommandContext): Promise<void> {
    const { deps } = this;
    const now = deps.clock();
    if (isLive(await deps.store.get(context.guildId), now)) {
      // The task replies to the interaction itself.
      await deps.queue.send({ kind: 'interaction', interaction, sentAt: now });
      return;
    }
    if (command.voice !== 'starts-call') {
      await context.editReply("I'm not in a voice channel right now.");
      return;
    }
    const call = await deps.calls.voiceChannelOf(context.guildId, context.userId);
    if (!call) {
      await context.editReply('You need to be in a voice channel first.');
      return;
    }
    if (await deps.store.claimStart(context.guildId, now)) {
      try {
        const taskArn = await deps.launcher.start();
        await deps.store.setTaskArn(context.guildId, taskArn);
        deps.logger.info(`Started a voice task for guild ${context.guildId} (${taskArn}).`);
      } catch (error) {
        await deps.store.clear(context.guildId);
        deps.logger.error(`Could not start a voice task: ${describeError(error)}`);
        await context.editReply("I couldn't get started for the call. Please try again in a minute.");
        return;
      }
    }
    // Picked up by the task once it's connected; it then replaces this reply.
    await deps.queue.send({ kind: 'interaction', interaction, sentAt: now });
    await context.editReply(`On my way to **${call.name}**… give me about half a minute.`);
  }

}

/** Lets other processes (the reminder Lambda) speak through the voice task when it's in a call. */
export class VoiceTaskAnnouncer {
  constructor(private readonly deps: { store: VoiceTaskStore; queue: VoiceTaskQueue; clock: Clock }) {}

  /** Who is in the call with the bot in this guild, or undefined when it isn't in one. */
  async callMembers(guildId: string): Promise<ReadonlyArray<{ id: string }> | undefined> {
    const record = await this.deps.store.get(guildId);
    return isLive(record, this.deps.clock()) && record.status === 'running' ? record.call?.people : undefined;
  }

  /** Asks the running voice task to say something. Resolves false if it isn't in a call. */
  async announce(guildId: string, text: string): Promise<boolean> {
    const now = this.deps.clock();
    const record = await this.deps.store.get(guildId);
    if (!isLive(record, now) || record.status !== 'running' || !record.call) return false;
    await this.deps.queue.send({ kind: 'announce', guildId, text, sentAt: now });
    return true;
  }

  /** The call the voice task reports, for answering "who's in the call?" without a live connection. */
  async currentCall(guildId: string): Promise<CallSnapshot | undefined> {
    const record = await this.deps.store.get(guildId);
    return isLive(record, this.deps.clock()) && record.status === 'running' ? record.call : undefined;
  }
}

/** Interaction tokens last 15 minutes; an order older than this can't be answered any more. */
const MAX_ORDER_AGE_MS = 14 * 60_000;
const HEARTBEAT_EVERY_MS = 30_000;

export interface VoiceTaskRunnerDeps {
  guildId: string;
  store: VoiceTaskStore;
  queue: VoiceTaskQueue;
  /** Runs a relayed voice command. */
  runInteraction(interaction: APIChatInputApplicationCommandGuildInteraction): Promise<void>;
  announce(guildId: string, text: string): Promise<boolean>;
  /** The call the bot is in right now, if any. */
  currentCall(): CallSnapshot | undefined;
  /** Called on each heartbeat (e.g. to pick up spending recorded elsewhere). */
  onHeartbeat?(): Promise<void>;
  /** Exit after this long without being in a call (after the first order, or since the last call ended). */
  idleExitMs: number;
  clock: Clock;
  logger: Logger;
}

/**
 * The voice task's main loop: takes orders from the queue, reports in, and finishes once the bot
 * has been out of a call for `idleExitMs`. Before finishing it clears the status record and checks
 * the queue once more, so an order that arrives in that moment isn't lost.
 */
export class VoiceTaskRunner {
  private readonly aborter = new AbortController();
  private stopping = false;
  private idleSince: number;
  private lastHeartbeat = 0;

  constructor(private readonly deps: VoiceTaskRunnerDeps) {
    this.idleSince = deps.clock();
  }

  /** Resolves when the task should exit. */
  async run(): Promise<void> {
    const { deps } = this;
    await this.heartbeat(true);
    while (!this.stopping) {
      const received = await deps.queue.receive(20, this.aborter.signal).catch((error: unknown) => {
        deps.logger.warn(`Reading the voice task queue failed: ${describeError(error)}`);
        return [];
      });
      await this.handle(received);
      await this.heartbeat(false);
      if (deps.currentCall()) this.idleSince = deps.clock();
      else if (deps.clock() - this.idleSince >= deps.idleExitMs && (await this.finish())) return;
    }
  }

  /** Stops waiting for orders (SIGTERM). */
  stop(): void {
    this.stopping = true;
    this.aborter.abort();
  }

  private async handle(received: readonly ReceivedMessage[]): Promise<void> {
    for (const { message, receipt } of received) {
      try {
        if (message.kind === 'interaction') {
          if (this.deps.clock() - message.sentAt > MAX_ORDER_AGE_MS) {
            this.deps.logger.warn(`Skipping /${message.interaction.data.name}: it's too old to answer.`);
          } else {
            await this.deps.runInteraction(message.interaction);
          }
        } else if (!(await this.deps.announce(message.guildId, message.text))) {
          this.deps.logger.info('Dropped an announcement: not in a call any more.');
        }
      } catch (error) {
        this.deps.logger.error(`Voice task order failed: ${describeError(error)}`);
      }
      await this.deps.queue.delete(receipt).catch((error: unknown) => this.deps.logger.warn(`Could not delete a queue message: ${describeError(error)}`));
      if (this.deps.currentCall()) this.idleSince = this.deps.clock();
    }
  }

  private async heartbeat(force: boolean): Promise<void> {
    const now = this.deps.clock();
    if (!force && now - this.lastHeartbeat < HEARTBEAT_EVERY_MS) return;
    this.lastHeartbeat = now;
    try {
      await this.deps.store.heartbeat(this.deps.guildId, now, this.deps.currentCall());
      await this.deps.onHeartbeat?.();
    } catch (error) {
      this.deps.logger.warn(`Voice task heartbeat failed: ${describeError(error)}`);
    }
  }

  /** Clears the status record; if an order slipped in meanwhile, carries on instead. Returns whether to exit. */
  private async finish(): Promise<boolean> {
    await this.deps.store.clear(this.deps.guildId);
    const lastOrders = await this.deps.queue.receive(0).catch(() => []);
    if (lastOrders.length === 0) {
      this.deps.logger.info('No call for a while; the voice task is finishing.');
      return true;
    }
    await this.heartbeat(true);
    await this.handle(lastOrders);
    this.idleSince = this.deps.clock();
    return false;
  }
}

/** In-memory store and queue, for tests and for running the voice task code locally. */
export class MemoryVoiceTaskStore implements VoiceTaskStore {
  readonly records = new Map<string, VoiceTaskRecord>();

  async get(guildId: string): Promise<VoiceTaskRecord | undefined> {
    const record = this.records.get(guildId);
    return record ? structuredClone(record) : undefined;
  }

  async claimStart(guildId: string, now: number): Promise<boolean> {
    if (isLive(this.records.get(guildId), now)) return false;
    this.records.set(guildId, { guildId, status: 'starting', startedAt: now, heartbeatAt: now });
    return true;
  }

  async heartbeat(guildId: string, now: number, call: CallSnapshot | undefined): Promise<void> {
    const previous = this.records.get(guildId);
    this.records.set(guildId, {
      guildId,
      status: 'running',
      startedAt: previous?.startedAt ?? now,
      heartbeatAt: now,
      ...(previous?.taskArn ? { taskArn: previous.taskArn } : {}),
      ...(call ? { call } : {}),
    });
  }

  async setTaskArn(guildId: string, taskArn: string): Promise<void> {
    const record = this.records.get(guildId);
    if (record) record.taskArn = taskArn;
  }

  async clear(guildId: string): Promise<void> {
    this.records.delete(guildId);
  }
}

export class MemoryVoiceTaskQueue implements VoiceTaskQueue {
  readonly pending: ReceivedMessage[] = [];
  private nextReceipt = 0;
  private waiters: Array<() => void> = [];

  async send(message: VoiceTaskMessage): Promise<void> {
    this.pending.push({ message: structuredClone(message), receipt: String(this.nextReceipt++) });
    for (const wake of this.waiters.splice(0)) wake();
  }

  async receive(waitSeconds: number, signal?: AbortSignal): Promise<ReceivedMessage[]> {
    if (this.pending.length === 0 && waitSeconds > 0 && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitSeconds * 1000);
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        this.waiters.push(wake);
        signal?.addEventListener('abort', wake, { once: true });
      });
    }
    return this.pending.splice(0, 10);
  }

  async delete(_receipt: string): Promise<void> {
    // Received messages are removed from `pending` already.
  }
}
