import type { Logger } from '../logging/logger.js';
import { describeError } from '../logging/logger.js';
import type { Reminder } from '../storage/ports.js';
import { describeClockTime, describeLength, describeLocalTime, localDayKey } from '../util/zonedTime.js';
import { describeRepeat } from './recurrence.js';
import type { DeliverReminder, ReminderDeliveryInfo } from './ReminderScheduler.js';

/** What delivery needs from the voice side. */
export interface ReminderVoice {
  /** The people in the call with the assistant in this guild, or undefined when it isn't in one. */
  callMembers(guildId: string): ReadonlyArray<{ id: string }> | undefined | Promise<ReadonlyArray<{ id: string }> | undefined>;
  /** Says `text` in the guild's call. Resolves false if it couldn't. */
  announce(guildId: string, text: string): Promise<boolean>;
}

/** What delivery needs from Discord's text side. */
export interface ReminderMessenger {
  /** Posts in a channel of the guild (a voice channel's chat works too), pinging only `mentionUserId`. Throws on failure. */
  postInChannel(guildId: string, channelId: string, content: string, mentionUserId: string): Promise<void>;
  /** Sends a direct message. Throws on failure. */
  sendDirect(userId: string, content: string): Promise<void>;
}

/**
 * Delivers a due reminder: out loud when it's for someone in a call with the assistant (or for
 * everyone and the assistant is in a call), otherwise as a mention in the channel it was set from,
 * and as a direct message if that channel can't be used.
 */
export function createReminderDelivery(deps: { voice: ReminderVoice; messenger: ReminderMessenger; logger: Logger }): DeliverReminder {
  return async (reminder, info) => {
    const members = await deps.voice.callMembers(reminder.guildId);
    const hearable =
      members !== undefined && (reminder.audience === 'everyone' ? members.length > 0 : members.some((member) => member.id === reminder.userId));
    if (hearable && (await deps.voice.announce(reminder.guildId, spokenReminder(reminder, info)))) {
      deps.logger.info(`Said reminder #${reminder.id} in the call${info.late ? ' (late)' : ''}.`);
      return;
    }

    const text = writtenReminder(reminder, info);
    try {
      await deps.messenger.postInChannel(reminder.guildId, reminder.channelId, text, reminder.userId);
      deps.logger.info(`Posted reminder #${reminder.id} in channel ${reminder.channelId}${info.late ? ' (late)' : ''}.`);
      return;
    } catch (error) {
      deps.logger.warn(`Could not post reminder #${reminder.id} in channel ${reminder.channelId}: ${describeError(error)}`);
    }
    await deps.messenger.sendDirect(reminder.userId, text);
    deps.logger.info(`Sent reminder #${reminder.id} to ${reminder.userName} directly.`);
  };
}

/** What the assistant says, e.g. "Alice, here's your reminder: start the raid." */
export function spokenReminder(reminder: Reminder, info: ReminderDeliveryInfo): string {
  const name = reminder.userName;
  const when = lateTime(reminder, info);
  if (reminder.kind === 'timer') {
    const length = reminder.durationMs ? `${describeLength(reminder.durationMs)} ` : '';
    const label = reminder.message ? ` for ${reminder.message}` : '';
    if (reminder.audience === 'everyone') {
      return info.late
        ? `The ${length}timer ${name} set${label} went off ${when}, while I was offline.`
        : `Time's up! The ${length}timer ${name} set${label} is done.`;
    }
    return info.late
      ? `${name}, your ${length}timer${label} went off ${when}, while I was offline.`
      : `${name}, your ${length}timer${label} is done.`;
  }
  const message = sentence(reminder.message);
  const lead = reminder.audience === 'everyone' ? `Reminder for everyone, from ${name}: ` : `${name}, here's your reminder: `;
  return `${lead}${message}${info.late ? ` Sorry it's late; it was due ${when}, while I was offline.` : ''}`;
}

/** The message posted in a channel or sent directly (Discord markdown, timestamps shown in each reader's time zone). */
export function writtenReminder(reminder: Reminder, info: ReminderDeliveryInfo): string {
  const mention = `<@${reminder.userId}>`;
  let body: string;
  if (reminder.kind === 'timer') {
    const length = reminder.durationMs ? `${describeLength(reminder.durationMs)} ` : '';
    const label = reminder.message ? ` for ${reminder.message}` : '';
    body =
      reminder.audience === 'everyone'
        ? `⏲️ ${mention} The ${length}timer you set${label} for everyone is done.`
        : `⏲️ ${mention} Your ${length}timer${label} is done.`;
  } else {
    body =
      reminder.audience === 'everyone'
        ? `⏰ ${mention} Reminder for everyone, from ${reminder.userName}: ${reminder.message}`
        : `⏰ ${mention} Reminder: ${reminder.message}`;
  }
  const notes: string[] = [];
  if (info.late) notes.push(`This was due <t:${unix(reminder.dueAt)}:f>, but I was offline.`);
  if (reminder.repeat && info.nextDueAt !== null) {
    notes.push(`Repeats ${describeRepeat(reminder.repeat)}; next <t:${unix(info.nextDueAt)}:R>. To stop it, ask me to cancel reminder #${reminder.id}.`);
  }
  return [body, ...notes.map((note) => `-# ${note}`)].join('\n');
}

/** "at 2:00 PM" when it was due today, otherwise "on Thursday, November 26 at 2:00 PM". */
function lateTime(reminder: Reminder, info: ReminderDeliveryInfo): string {
  const sameDay = localDayKey(reminder.dueAt, reminder.timeZone) === localDayKey(info.now, reminder.timeZone);
  return sameDay
    ? `at ${describeClockTime(reminder.dueAt, reminder.timeZone)}`
    : `on ${describeLocalTime(reminder.dueAt, reminder.timeZone, info.now)}`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function unix(epochMs: number): number {
  return Math.floor(epochMs / 1000);
}
