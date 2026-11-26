import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ConversationRepository, Memory, MemoryRepository, TranscriptRepository } from '../storage/ports.js';
import { parseTimestamp, systemClock, type Clock } from '../util/time.js';
import {
  formatConversationSearch,
  formatMemoryList,
  formatSessionList,
  formatTranscriptRange,
  formatTranscriptSearch,
} from './format.js';

export const MEMORY_SERVER_NAME = 'discord-memory';
export const MEMORY_SERVER_VERSION = '1.0.0';

/**
 * Parameters that identify *whose* memory a call reads. They are part of each tool's schema so the
 * server is usable on its own (for example from Claude Desktop over stdio), but the bot hides them
 * from the model and fills them in from the Discord context, so a model can never read another
 * server's or another person's data. See assistant/tools/McpToolProvider.ts.
 */
export const SCOPE_PARAMS = {
  guildId: 'guild_id',
  userId: 'user_id',
  userName: 'user_name',
} as const;

/** Longest note the assistant may save, and most notes kept per person (or for the server). */
export const MAX_MEMORY_LENGTH = 300;
export const MAX_MEMORIES_PER_SUBJECT = 50;

export interface MemoryServerDeps {
  transcripts: TranscriptRepository;
  conversations: ConversationRepository;
  memories: MemoryRepository;
  clock?: Clock;
}

const isoTime = (what: string) =>
  z.string().describe(`${what}, as an ISO-8601 date/time (e.g. 2026-11-26T19:00:00Z). The current time is in your system note.`);

/** Builds the memory MCP server. Connect it to any MCP transport (in-memory, stdio, HTTP). */
export function createMemoryMcpServer(deps: MemoryServerDeps): McpServer {
  const server = new McpServer(
    { name: MEMORY_SERVER_NAME, version: MEMORY_SERVER_VERSION },
    {
      instructions:
        'Long-term memory for a Discord assistant: transcripts of what people said in voice channels, ' +
        "each person's own earlier conversation with the assistant, and long-term notes about people and the server.",
    },
  );

  const guildId = z.string().min(1).describe('Discord server (guild) ID whose memory to read.');

  server.registerTool(
    'search_voice_transcripts',
    {
      title: 'Search voice transcripts',
      description:
        "Keyword search over what people have said in this server's voice channels, including what you said aloud. " +
        "Use it when someone refers to something said in a call that you can't see in the recent excerpt, for example " +
        '"what did Sam say about the trip?" or "when did we talk about Japan?". Pass the distinctive words likely to ' +
        'have been spoken (names, places, topics). If nothing comes back, try synonyms or fewer words before concluding ' +
        "it wasn't discussed. Returns matching lines with a little of the surrounding conversation.",
      inputSchema: {
        [SCOPE_PARAMS.guildId]: guildId,
        query: z.string().min(1).describe('Words to look for.'),
        speaker: z
          .string()
          .optional()
          .describe('Only lines from this person: a display name (partial, case-insensitive) or a Discord user ID.'),
        since: isoTime('Only lines spoken at or after this time').optional(),
        until: isoTime('Only lines spoken at or before this time').optional(),
        session_id: z.number().int().positive().optional().describe('Only lines from this voice session.'),
        limit: z.number().int().min(1).max(20).optional().describe('Maximum matches to return (default 8).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      guarded(async () => {
        const hits = await deps.transcripts.search({
          guildId: args[SCOPE_PARAMS.guildId],
          query: args.query,
          speaker: args.speaker,
          since: parseTimestamp(args.since, 'since'),
          until: parseTimestamp(args.until, 'until'),
          sessionId: args.session_id,
          limit: args.limit ?? 8,
          contextSegments: 2,
        });
        return formatTranscriptSearch(hits);
      }),
  );

  server.registerTool(
    'read_voice_transcript',
    {
      title: 'Read voice transcript',
      description:
        'Read the voice-channel transcript in time order. Use it to summarise a call or catch up on a stretch of ' +
        'conversation, for example "what were we talking about an hour ago?" or "sum up last night". Narrow it with a ' +
        'session (from list_voice_sessions), a time range, or a speaker. By default it returns the most recent lines in ' +
        'the range; when more exist than the limit, the result says how to page.',
      inputSchema: {
        [SCOPE_PARAMS.guildId]: guildId,
        session_id: z.number().int().positive().optional().describe('Voice session to read.'),
        since: isoTime('Start of the range').optional(),
        until: isoTime('End of the range').optional(),
        speaker: z.string().optional().describe('Only lines from this person (display name or Discord user ID).'),
        limit: z.number().int().min(1).max(300).optional().describe('Maximum lines to return (default 100).'),
        from: z
          .enum(['start', 'end'])
          .optional()
          .describe('Read from the start or the end of the range when it holds more lines than the limit (default end).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      guarded(async () => {
        const fromEnd = (args.from ?? 'end') === 'end';
        const { segments, hasMore } = await deps.transcripts.readRange({
          guildId: args[SCOPE_PARAMS.guildId],
          sessionId: args.session_id,
          since: parseTimestamp(args.since, 'since'),
          until: parseTimestamp(args.until, 'until'),
          speaker: args.speaker,
          limit: args.limit ?? 100,
          order: fromEnd ? 'newest_first' : 'oldest_first',
        });
        return formatTranscriptRange(segments, hasMore, fromEnd);
      }),
  );

  server.registerTool(
    'list_voice_sessions',
    {
      title: 'List voice sessions',
      description:
        'List recent voice sessions (each stretch of time you were listening in a voice channel), newest first, with ' +
        'when they happened, who spoke and how much was said. Use it to find the session behind questions like ' +
        '"what did we talk about last night?" before reading it.',
      inputSchema: {
        [SCOPE_PARAMS.guildId]: guildId,
        since: isoTime('Only sessions active at or after this time').optional(),
        limit: z.number().int().min(1).max(25).optional().describe('Maximum sessions to return (default 10).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      guarded(async () => {
        const sessions = await deps.transcripts.listSessions(args[SCOPE_PARAMS.guildId], {
          since: parseTimestamp(args.since, 'since'),
          limit: args.limit ?? 10,
        });
        return formatSessionList(sessions);
      }),
  );

  server.registerTool(
    'search_my_conversation_history',
    {
      title: "Search this person's history with you",
      description:
        "Keyword search over this person's own earlier conversation with you, typed or spoken, including parts that " +
        'are no longer in view. Use it when they refer back to something you can\'t see, for example "like I told you ' +
        'last week" or "what was that book you recommended?".',
      inputSchema: {
        [SCOPE_PARAMS.guildId]: guildId,
        [SCOPE_PARAMS.userId]: z.string().min(1).describe('Discord user ID whose history to search.'),
        query: z.string().min(1).describe('Words to look for.'),
        limit: z.number().int().min(1).max(20).optional().describe('Maximum results (default 8).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      guarded(async () => {
        const hits = await deps.conversations.search(
          { guildId: args[SCOPE_PARAMS.guildId], userId: args[SCOPE_PARAMS.userId] },
          args.query,
          args.limit ?? 8,
        );
        return formatConversationSearch(hits);
      }),
  );

  // -------------------------------------------------------------------------
  // Long-term notes about people and the server
  // -------------------------------------------------------------------------

  const clock = deps.clock ?? systemClock;
  const speakerId = z.string().min(1).describe('Discord user ID of the person talking to the assistant.');
  const speakerName = z.string().min(1).describe('Display name of the person talking to the assistant.');
  const memoryId = z.number().int().positive().describe('Note number, as shown with each note (#12 is 12).');

  server.registerTool(
    'remember',
    {
      title: 'Remember a note',
      description:
        "Save a lasting note about the person you're talking to, someone else in this server, or the server as a whole. " +
        'Use it when someone tells you something worth knowing next time, such as preferences, birthdays, pets, running ' +
        'jokes or plans. Write it as a short standalone statement ("Is vegetarian", "Birthday: May 3"). If a note about ' +
        'the same thing already exists, use update_memory instead. Notes are visible to everyone in the server.',
      inputSchema: {
        [SCOPE_PARAMS.guildId]: guildId,
        [SCOPE_PARAMS.userId]: speakerId,
        [SCOPE_PARAMS.userName]: speakerName,
        fact: z.string().min(1).describe(`The note, at most ${MAX_MEMORY_LENGTH} characters.`),
        about_user_id: z
          .string()
          .optional()
          .describe(
            "Discord user ID of who the note is about. Leave it out when it's about the person you're talking to; use \"server\" for something about the whole server.",
          ),
        about_name: z.string().optional().describe('Display name of that person (needed when the note is about someone else).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      guarded(async () => {
        const guild = args[SCOPE_PARAMS.guildId];
        const fact = checkFact(args.fact);
        const about = args.about_user_id?.trim();
        let subjectId: string | null;
        let subjectName: string;
        if (about?.toLowerCase() === 'server') {
          subjectId = null;
          subjectName = 'the server';
        } else if (!about || about === args[SCOPE_PARAMS.userId]) {
          subjectId = args[SCOPE_PARAMS.userId];
          subjectName = args[SCOPE_PARAMS.userName];
        } else {
          if (!/^\d{17,20}$/.test(about)) throw new Error('about_user_id must be a Discord user ID (a long number) or "server".');
          subjectId = about;
          subjectName = args.about_name?.trim() || `user ${about}`;
        }

        const existing = await deps.memories.listAbout(guild, [subjectId], MAX_MEMORIES_PER_SUBJECT);
        const duplicate = existing.find((memory) => memory.text.trim().toLowerCase() === fact.toLowerCase());
        if (duplicate) return `Already remembered as note #${duplicate.id} about ${duplicate.subjectName}.`;
        if ((await deps.memories.countAbout(guild, subjectId)) >= MAX_MEMORIES_PER_SUBJECT) {
          throw new Error(
            `There are already ${MAX_MEMORIES_PER_SUBJECT} notes about ${subjectName}. Update or forget an old one first.`,
          );
        }
        const memory = await deps.memories.add({
          guildId: guild,
          subjectId,
          subjectName,
          text: fact,
          sourceUserId: args[SCOPE_PARAMS.userId],
          sourceName: args[SCOPE_PARAMS.userName],
          createdAt: clock(),
        });
        return `Saved note #${memory.id} about ${memory.subjectName}.`;
      }),
  );

  server.registerTool(
    'update_memory',
    {
      title: 'Update a note',
      description:
        'Rewrite one of your notes when it has changed or was wrong (for example a new favourite game). Notes about a ' +
        'person can be changed by that person or by whoever told you; notes about the server by anyone.',
      inputSchema: {
        [SCOPE_PARAMS.guildId]: guildId,
        [SCOPE_PARAMS.userId]: speakerId,
        memory_id: memoryId,
        fact: z.string().min(1).describe(`The new note, at most ${MAX_MEMORY_LENGTH} characters.`),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guarded(async () => {
        const guild = args[SCOPE_PARAMS.guildId];
        const memory = await requireChangeable(deps.memories, guild, args.memory_id, args[SCOPE_PARAMS.userId]);
        const updated = await deps.memories.update(guild, memory.id, checkFact(args.fact), clock());
        return `Updated note #${memory.id} about ${updated?.subjectName ?? memory.subjectName}.`;
      }),
  );

  server.registerTool(
    'forget_memory',
    {
      title: 'Forget a note',
      description:
        'Delete one of your notes, for example when someone asks you to forget something. Notes about a person can be ' +
        'deleted by that person or by whoever told you; notes about the server by anyone.',
      inputSchema: {
        [SCOPE_PARAMS.guildId]: guildId,
        [SCOPE_PARAMS.userId]: speakerId,
        memory_id: memoryId,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guarded(async () => {
        const guild = args[SCOPE_PARAMS.guildId];
        const memory = await requireChangeable(deps.memories, guild, args.memory_id, args[SCOPE_PARAMS.userId]);
        await deps.memories.delete(guild, memory.id);
        return `Forgot note #${memory.id} about ${memory.subjectName}.`;
      }),
  );

  server.registerTool(
    'search_memories',
    {
      title: 'Search notes',
      description:
        "Look through your notes about people in this server and about the server itself. Notes about whoever is in the " +
        'conversation are already attached to the message; use this for anyone or anything else, for example ' +
        '"what\'s Sam\'s favourite game?" when Sam isn\'t around. With about_user_id you get all of that person\'s ' +
        'notes (best matches for the query first); with only a query you get the best matches across everyone.',
      inputSchema: {
        [SCOPE_PARAMS.guildId]: guildId,
        query: z.string().optional().describe('Words to look for.'),
        about_user_id: z.string().optional().describe('Only notes about this person (Discord user ID), or "server".'),
        limit: z.number().int().min(1).max(30).optional().describe('Maximum notes to return (default 15).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      guarded(async () => {
        const guild = args[SCOPE_PARAMS.guildId];
        const limit = args.limit ?? 15;
        const about = args.about_user_id?.trim();
        let found: Memory[];
        if (about) {
          // A person has at most MAX_MEMORIES_PER_SUBJECT notes, so return them all, query matches first:
          // filtering by the query's exact words would hide relevant notes ("Is vegetarian" for "dinner").
          const subject = about.toLowerCase() === 'server' ? null : about;
          found = await deps.memories.listAbout(guild, [subject], MAX_MEMORIES_PER_SUBJECT);
          if (args.query?.trim()) {
            const matches = new Set((await deps.memories.search(guild, args.query, 200)).map((memory) => memory.id));
            found = [...found.filter((m) => matches.has(m.id)), ...found.filter((m) => !matches.has(m.id))];
          }
          found = found.slice(0, limit);
        } else if (args.query?.trim()) {
          found = await deps.memories.search(guild, args.query, limit);
        } else {
          throw new Error('Give a query, an about_user_id, or both.');
        }
        return formatMemoryList(found);
      }),
  );

  return server;
}

function checkFact(fact: string): string {
  const text = fact.replace(/\s+/g, ' ').trim();
  if (text.length === 0) throw new Error('The note is empty.');
  if (text.length > MAX_MEMORY_LENGTH) {
    throw new Error(`That note is ${text.length} characters; keep it under ${MAX_MEMORY_LENGTH}.`);
  }
  return text;
}

/** A person's notes can be changed by them or by whoever gave them; server notes by anyone. */
async function requireChangeable(memories: MemoryRepository, guildId: string, id: number, userId: string): Promise<Memory> {
  const memory = await memories.get(guildId, id);
  if (!memory) throw new Error(`There is no note #${id}.`);
  const allowed = memory.subjectId === null || memory.subjectId === userId || memory.sourceUserId === userId;
  if (!allowed) {
    throw new Error(
      `Note #${id} is about ${memory.subjectName}; only they (or ${memory.sourceName}, who told you) can change or delete it.`,
    );
  }
  return memory;
}

async function guarded(run: () => Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: await run() }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}
