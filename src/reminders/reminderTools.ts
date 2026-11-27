import { z } from 'zod';
import { NativeToolProvider, defineTool } from '../assistant/tools/nativeTool.js';
import type { ToolResult } from '../assistant/tools/types.js';
import type { Reminder, ReminderRepository, RepeatRule } from '../storage/ports.js';
import type { ReminderAlarm } from './alarm.js';
import type { Clock } from '../util/time.js';
import { describeDuration, describeLength, describeLocalTime, parseLocalOrAbsolute } from '../util/zonedTime.js';
import { RepeatError, WEEKDAY_NAMES, alignFirstOccurrence, buildRepeatRule, describeRepeat, nextOccurrence } from './recurrence.js';

/** Most reminders one person can have active at once. */
export const MAX_ACTIVE_REMINDERS = 25;
const MAX_MESSAGE_LENGTH = 300;
const MIN_DELAY_SECONDS = 5;
const MAX_DELAY_SECONDS = 366 * 24 * 60 * 60;

export interface ReminderToolDeps {
  reminders: ReminderRepository;
  /** Arranges delivery of new reminders (and calls off cancelled ones). */
  alarm: ReminderAlarm;
  clock: Clock;
  timeZone: string;
}

const error = (content: string): ToolResult => ({ content, isError: true });

export function createReminderToolProvider(deps: ReminderToolDeps): NativeToolProvider {
  return new NativeToolProvider('reminders', [
    defineTool({
      name: 'set_reminder',
      description:
        'Set a reminder or a timer for the person you are talking to. It is said out loud in the voice call if ' +
        "they're in one with you when it's due, otherwise posted as a mention in the channel they asked from. " +
        'Give exactly one of "at" (a local date and time) or "in_seconds" (a delay). Use kind "timer" for countdowns ' +
        '("set a timer for 10 minutes"), and for_everyone when they say "remind us" or it is for the whole call.',
      input: z.object({
        message: z
          .string()
          .max(MAX_MESSAGE_LENGTH)
          .optional()
          .describe('What to remind them about, as a short phrase ("start the raid"). Optional label for a timer ("pizza").'),
        kind: z.enum(['reminder', 'timer']).optional().describe('Default "reminder".'),
        at: z
          .string()
          .optional()
          .describe(
            'When, as a local wall-clock time in the server time zone with no offset, e.g. "2026-11-27T21:00". The current local time is in your situation note.',
          ),
        in_seconds: z
          .number()
          .int()
          .min(MIN_DELAY_SECONDS)
          .max(MAX_DELAY_SECONDS)
          .optional()
          .describe('Or how long from now, in seconds (600 for "in 10 minutes").'),
        repeat: z
          .object({
            every: z.enum(['minute', 'hour', 'day', 'week', 'month', 'year']),
            interval: z.number().int().min(1).max(1000).optional().describe('Every N units (default 1, e.g. 2 for every other week).'),
            weekdays: z
              .array(z.enum(WEEKDAY_NAMES))
              .min(1)
              .max(7)
              .optional()
              .describe('For weekly repeats on particular days, e.g. ["mon", "wed", "fri"]; "at" then gives the time of day.'),
          })
          .optional()
          .describe('Leave out for a one-off. Timers do not repeat.'),
        for_everyone: z.boolean().optional().describe('True when it is for everyone in the call, not just this person.'),
      }),
      run: async (input, context) => {
        const now = deps.clock();
        const kind = input.kind ?? 'reminder';
        const message = input.message?.replace(/\s+/g, ' ').trim() ?? '';
        if (kind === 'reminder' && message.length === 0) return error('Say what the reminder is for in "message".');
        if (kind === 'timer' && input.repeat) return error('Timers do not repeat; set a repeating reminder instead.');
        if ((input.at === undefined) === (input.in_seconds === undefined)) return error('Give exactly one of "at" or "in_seconds".');
        if (!context.textChannelId) return error("There's no channel to deliver a reminder to from here.");
        if ((await deps.reminders.countActive(context.guildId, context.userId)) >= MAX_ACTIVE_REMINDERS) {
          return error(`${context.userDisplayName} already has ${MAX_ACTIVE_REMINDERS} active reminders; cancel one first.`);
        }

        let dueAt: number;
        let durationMs: number | null = null;
        if (input.in_seconds !== undefined) {
          durationMs = input.in_seconds * 1000;
          dueAt = now + durationMs;
        } else {
          const parsed = parseLocalOrAbsolute(input.at!, deps.timeZone);
          if (parsed === undefined) {
            return error(`"at" must look like 2026-11-27T21:00 (local time in ${deps.timeZone}); got "${input.at}".`);
          }
          dueAt = parsed;
        }

        let repeat: RepeatRule | null = null;
        try {
          if (input.repeat) {
            repeat = buildRepeatRule(input.repeat, dueAt, deps.timeZone);
            dueAt = alignFirstOccurrence(dueAt, repeat, deps.timeZone);
            // "Every day at 9" asked for at 10: start tomorrow.
            if (dueAt <= now) dueAt = nextOccurrence(repeat, dueAt, deps.timeZone, now);
          }
        } catch (problem) {
          if (problem instanceof RepeatError) return error(problem.message);
          throw problem;
        }
        if (dueAt <= now) {
          return error(`That time has already passed (it is now ${describeLocalTime(now, deps.timeZone, now)}).`);
        }

        const reminder = await deps.reminders.create({
          guildId: context.guildId,
          userId: context.userId,
          userName: context.userDisplayName,
          kind,
          message,
          audience: input.for_everyone ? 'everyone' : 'me',
          channelId: context.textChannelId,
          dueAt,
          repeat,
          timeZone: deps.timeZone,
          durationMs,
          createdAt: now,
        });
        await deps.alarm.set(reminder);
        const when = `${describeLocalTime(dueAt, deps.timeZone, now)} (in ${describeDuration(dueAt - now)})`;
        const everyone = input.for_everyone ? ', for everyone in the call' : '';
        if (kind === 'timer') {
          const label = message ? ` for ${message}` : '';
          return `Set a ${describeLength(durationMs ?? dueAt - now)} timer${label} (#${reminder.id}). It goes off ${when}${everyone}.`;
        }
        const repeats = repeat ? `, repeating ${describeRepeat(repeat)}` : '';
        return `Set reminder #${reminder.id}, "${message}", for ${when}${repeats}${everyone}.`;
      },
    }),
    defineTool({
      name: 'list_reminders',
      description: "List the reminders and timers the person you are talking to has set that haven't gone off yet.",
      input: z.object({}),
      run: async (_input, context) => {
        const now = deps.clock();
        const active = await deps.reminders.listActive(context.guildId, context.userId);
        if (active.length === 0) return `${context.userDisplayName} has no reminders or timers set.`;
        return active.map((reminder) => `- ${describeReminder(reminder, deps.timeZone, now)}`).join('\n');
      },
    }),
    defineTool({
      name: 'cancel_reminder',
      description: 'Cancel one of the reminders or timers the person you are talking to has set (find its number with list_reminders).',
      input: z.object({
        reminder_id: z.number().int().positive().describe('The reminder number, e.g. 12 for #12.'),
      }),
      run: async ({ reminder_id }, context) => {
        const reminder = await deps.reminders.get(context.guildId, reminder_id);
        if (!reminder || reminder.status !== 'active') return error(`There is no active reminder #${reminder_id}.`);
        if (reminder.userId !== context.userId) {
          return error(`Reminder #${reminder_id} was set by ${reminder.userName}; only they can cancel it.`);
        }
        await deps.reminders.cancel(context.guildId, reminder_id);
        await deps.alarm.clear(reminder_id);
        return `Cancelled ${describeReminder(reminder, deps.timeZone, deps.clock())}`;
      },
    }),
  ]);
}

/** One line per reminder, e.g. `#12 Friday, November 27 at 9:00 PM: start the raid (for everyone; repeats every week)`. */
export function describeReminder(reminder: Reminder, timeZone: string, now: number): string {
  const label =
    reminder.kind === 'timer'
      ? `${reminder.durationMs ? `${describeLength(reminder.durationMs)} ` : ''}timer${reminder.message ? ` for ${reminder.message}` : ''}`
      : reminder.message;
  const notes = [
    reminder.audience === 'everyone' ? 'for everyone' : undefined,
    reminder.repeat ? `repeats ${describeRepeat(reminder.repeat)}` : undefined,
  ].filter(Boolean);
  return (
    `#${reminder.id} ${describeLocalTime(reminder.dueAt, timeZone, now)} (in ${describeDuration(reminder.dueAt - now)}): ${label}` +
    (notes.length > 0 ? ` (${notes.join('; ')})` : '')
  );
}
