/**
 * Storage ports. Everything the bot persists goes through these interfaces so the SQLite
 * implementations used on a single PC can later be swapped for hosted ones (for example
 * DynamoDB / Aurora / OpenSearch on AWS) without touching the assistant or Discord code.
 *
 * All methods are async even though SQLite is synchronous, because remote stores are not.
 */
import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';

/** Whether a turn happened through a typed /chat command or spoken in a voice channel. */
export type Modality = 'text' | 'voice';

/** One person's conversation thread with the assistant within one guild. */
export interface UserScope {
  guildId: string;
  userId: string;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface ConversationMessage {
  role: 'user' | 'assistant';
  /** Claude Messages API content blocks, already sanitised for replay (see assistant/history.ts). */
  content: BetaContentBlockParam[];
}

export interface StoredConversationMessage extends ConversationMessage {
  id: number;
  modality: Modality;
  createdAt: number;
}

export interface AppendTurnInput {
  scope: UserScope;
  modality: Modality;
  /** The messages of one complete turn, in order. The first must be the user's message. */
  messages: ConversationMessage[];
  createdAt: number;
}

export interface WindowPolicy {
  /** Once the active window holds more messages than this, it is shortened... */
  maxMessages: number;
  /** ...to at most this many, cut at a turn boundary. */
  keepMessages: number;
}

export interface ConversationSearchHit {
  messageId: number;
  role: 'user' | 'assistant';
  modality: Modality;
  createdAt: number;
  text: string;
  /** True when the message is no longer in the active context window. */
  archived: boolean;
}

export interface ConversationRepository {
  /** Messages in the active context window, oldest first. */
  loadActive(scope: UserScope): Promise<StoredConversationMessage[]>;
  /** Atomically appends a complete turn. */
  appendTurn(input: AppendTurnInput): Promise<void>;
  /**
   * Moves the start of the active window forward (never backward) so it holds at most
   * `policy.keepMessages` once it has grown past `policy.maxMessages`. Older messages stay
   * stored and searchable. Returns how many messages left the window.
   */
  trimWindow(scope: UserScope, policy: WindowPolicy): Promise<number>;
  /** Full-text search over this person's own history, including archived messages. */
  search(scope: UserScope, query: string, limit: number): Promise<ConversationSearchHit[]>;
  /** Deletes the whole thread for this person (the /reset command). */
  reset(scope: UserScope): Promise<void>;
  /** Deletes archived (out-of-window) messages created before `cutoff`. Returns rows deleted. */
  pruneArchivedBefore(cutoff: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Voice transcripts (ambient group memory)
// ---------------------------------------------------------------------------

export interface VoiceSessionRecord {
  id: number;
  guildId: string;
  channelId: string;
  channelName: string;
  startedAt: number;
  endedAt: number | null;
}

export interface VoiceSessionSummary extends VoiceSessionRecord {
  segmentCount: number;
  participants: string[];
  lastActivityAt: number | null;
  /** Short summary written when the call ended; null until then (or for calls too short to recap). */
  recap: string | null;
}

export interface TranscriptSegment {
  id: number;
  sessionId: number;
  guildId: string;
  channelId: string;
  speakerId: string;
  speakerName: string;
  isAssistant: boolean;
  text: string;
  startedAt: number;
  endedAt: number;
}

export type NewTranscriptSegment = Omit<TranscriptSegment, 'id'>;

export interface TranscriptFilters {
  guildId: string;
  sessionId?: number;
  /** Matches a Discord user ID exactly, or a display name case-insensitively (substring). */
  speaker?: string;
  since?: number;
  until?: number;
}

export interface TranscriptSearchQuery extends TranscriptFilters {
  query: string;
  limit: number;
  /** Segments of surrounding conversation to return before and after each hit. */
  contextSegments: number;
}

export interface TranscriptSearchHit {
  hit: TranscriptSegment;
  /** Name of the voice channel the hit's session took place in. */
  channelName: string;
  /** Surrounding segments in time order, including the hit itself. */
  context: TranscriptSegment[];
}

export interface TranscriptRangeQuery extends TranscriptFilters {
  limit: number;
  /** Which end of the range to read from when it holds more than `limit` segments. */
  order: 'oldest_first' | 'newest_first';
}

export interface TranscriptRepository {
  startSession(input: Omit<VoiceSessionRecord, 'id' | 'endedAt'>): Promise<VoiceSessionRecord>;
  endSession(sessionId: number, endedAt: number): Promise<void>;
  /** Closes sessions left open by a crash or restart. Returns how many were closed. */
  endOpenSessions(endedAt: number): Promise<number>;
  appendSegment(segment: NewTranscriptSegment): Promise<TranscriptSegment>;
  /** Segments from one session at or after `since`, oldest first, at most `limit` (the newest ones). */
  recentSegments(sessionId: number, since: number, limit: number): Promise<TranscriptSegment[]>;
  search(query: TranscriptSearchQuery): Promise<TranscriptSearchHit[]>;
  /** Segments matching the filters, returned oldest first. */
  readRange(query: TranscriptRangeQuery): Promise<{ segments: TranscriptSegment[]; hasMore: boolean }>;
  listSessions(guildId: string, options: { since?: number; limit: number }): Promise<VoiceSessionSummary[]>;
  getSession(sessionId: number): Promise<VoiceSessionRecord | undefined>;
  /** Stores the recap written for an ended session. */
  setRecap(sessionId: number, recap: string, recappedAt: number): Promise<void>;
  /**
   * Ended sessions (in any guild) that started at or after `since`, have no recap yet and hold at
   * least `minSegments` lines, oldest first.
   */
  sessionsNeedingRecap(since: number, minSegments: number): Promise<VoiceSessionRecord[]>;
  /** Deletes segments started before `cutoff`, and ended sessions left without segments. */
  pruneBefore(cutoff: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Per-user settings
// ---------------------------------------------------------------------------

/**
 * How much of what a person says in voice channels the bot transcribes:
 *  - full: everything (the default), so the assistant can follow the whole conversation.
 *  - requests: only what they say to the assistant (its name, or a follow-up right after its
 *    reply); everything else is dropped without being stored.
 *  - off: nothing. Their audio is never sent for transcription, so they can't talk to it by voice.
 */
export const PRIVACY_LEVELS = ['full', 'requests', 'off'] as const;
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

export interface UserSettings {
  style: string;
  privacy: PrivacyLevel;
}

export const DEFAULT_USER_SETTINGS: UserSettings = { style: 'default', privacy: 'full' };

export interface SettingsRepository {
  get(scope: UserScope): Promise<UserSettings | undefined>;
  /** Changes some settings; the rest keep their current (or default) values. */
  update(scope: UserScope, changes: Partial<UserSettings>): Promise<UserSettings>;
}

// ---------------------------------------------------------------------------
// Long-term memories (notes about people and the server)
// ---------------------------------------------------------------------------

/** A note Nimbus keeps about a person, or about the server as a whole (subjectId null). */
export interface Memory {
  id: number;
  guildId: string;
  /** Discord user id the note is about, or null for the server/group. */
  subjectId: string | null;
  /** Display name of the subject when the note was last written. */
  subjectName: string;
  text: string;
  /** Who told Nimbus. */
  sourceUserId: string;
  sourceName: string;
  createdAt: number;
  updatedAt: number;
}

export type NewMemory = Omit<Memory, 'id' | 'updatedAt'>;

export interface MemoryRepository {
  add(memory: NewMemory): Promise<Memory>;
  get(guildId: string, id: number): Promise<Memory | undefined>;
  /** Replaces a note's text. Returns the updated note, or undefined if it doesn't exist. */
  update(guildId: string, id: number, text: string, updatedAt: number): Promise<Memory | undefined>;
  delete(guildId: string, id: number): Promise<boolean>;
  /** Deletes every note about one person. Returns how many were deleted. */
  deleteAllAbout(guildId: string, subjectId: string): Promise<number>;
  /** Notes about the given subjects (null = the server), most recently updated first, at most `perSubject` each. */
  listAbout(guildId: string, subjectIds: ReadonlyArray<string | null>, perSubject: number): Promise<Memory[]>;
  countAbout(guildId: string, subjectId: string | null): Promise<number>;
  /** Full-text search across all notes in the guild. */
  search(guildId: string, query: string, limit: number): Promise<Memory[]>;
}

// ---------------------------------------------------------------------------
// Reminders and timers
// ---------------------------------------------------------------------------

export type RepeatUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

/**
 * How a reminder repeats. Day-or-longer repeats keep the local time of day (and day of month) of
 * the first occurrence in the reminder's time zone, across DST changes.
 */
export interface RepeatRule {
  every: RepeatUnit;
  /** Every `interval` units (1 = every day, 2 = every other day...). */
  interval: number;
  /** Weekly repeats on specific days (0 = Sunday ... 6 = Saturday); interval must be 1. */
  weekdays?: number[];
  /** Local time of day of the first occurrence, HH:MM:SS (day-or-longer repeats). */
  localTime?: string;
  /** Day of month of the first occurrence (monthly and yearly repeats). */
  dayOfMonth?: number;
  /** Month (1-12) of the first occurrence (yearly repeats). */
  month?: number;
}

export type ReminderKind = 'reminder' | 'timer';
/** Who a reminder is for: the person who set it, or everyone in the call with them. */
export type ReminderAudience = 'me' | 'everyone';
export type ReminderStatus = 'active' | 'done' | 'cancelled';

export interface Reminder {
  id: number;
  guildId: string;
  /** Who set it. Personal reminders are for them; only they can cancel it. */
  userId: string;
  userName: string;
  kind: ReminderKind;
  /** What to remind about (a timer's optional label). */
  message: string;
  audience: ReminderAudience;
  /** Text channel to post in when it can't be said in a voice call. */
  channelId: string;
  /** When it is next due. */
  dueAt: number;
  repeat: RepeatRule | null;
  timeZone: string;
  /** A timer's length, for saying "your 10 minute timer is done". */
  durationMs: number | null;
  createdAt: number;
  firedCount: number;
  lastFiredAt: number | null;
  status: ReminderStatus;
}

export type NewReminder = Omit<Reminder, 'id' | 'firedCount' | 'lastFiredAt' | 'status'>;

export interface ReminderRepository {
  create(reminder: NewReminder): Promise<Reminder>;
  get(guildId: string, id: number): Promise<Reminder | undefined>;
  /** A person's active reminders (including ones they set for everyone), soonest first. */
  listActive(guildId: string, userId: string): Promise<Reminder[]>;
  countActive(guildId: string, userId: string): Promise<number>;
  /** The active reminder due soonest, across all guilds. */
  nextDue(): Promise<Reminder | undefined>;
  /** Active reminders due at or before `now`, soonest first, at most `limit`. */
  listDue(now: number, limit: number): Promise<Reminder[]>;
  /** Records a delivery: moves a repeating reminder to `nextDueAt`, or marks a one-off done (null). */
  markFired(id: number, firedAt: number, nextDueAt: number | null): Promise<void>;
  /** Cancels an active reminder. Returns false if there was no active reminder with that id. */
  cancel(guildId: string, id: number): Promise<boolean>;
  /** Deletes finished (done or cancelled) reminders last changed before `cutoff`. */
  pruneFinishedBefore(cutoff: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Usage (for cost tracking and the daily budget)
// ---------------------------------------------------------------------------

/** One metered quantity on one day, e.g. `claude.claude-haiku-5-5.output_tokens`, with its cost. */
export interface UsageLine {
  metric: string;
  quantity: number;
  costUsd: number;
}

export interface UsageRepository {
  /** Adds quantities and costs to a guild's totals for a local day (`YYYY-MM-DD`). */
  add(guildId: string, day: string, lines: readonly UsageLine[]): Promise<void>;
  /** Every metric recorded for a guild on a day. */
  day(guildId: string, day: string): Promise<UsageLine[]>;
  /** Total cost per day between two days (inclusive), oldest first; days without usage are omitted. */
  dailyTotals(guildId: string, fromDay: string, toDay: string): Promise<Array<{ day: string; costUsd: number }>>;
}
