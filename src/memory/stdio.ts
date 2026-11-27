/**
 * Runs the memory MCP server on its own over stdio, against the bot's SQLite database.
 * This is the same server the bot uses in-process; running it standalone lets other MCP
 * clients (Claude Desktop, Claude Code, ...) query the Discord memory too:
 *
 *   { "command": "node", "args": ["/path/to/discord-bot/dist/memory/stdio.js"],
 *     "env": { "DATABASE_PATH": "/path/to/discord-bot/data/bot.db",
 *              "MEMORY_DATABASE_PATH": "/path/to/discord-bot/data/memories.db" } }
 *
 * In this mode the scope parameters (guild_id, user_id) are ordinary tool arguments.
 * stdout carries the MCP protocol, so diagnostics go to stderr.
 */
import dotenv from 'dotenv';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase, openMemoryDatabase } from '../storage/sqlite/database.js';
import { SqliteConversationRepository } from '../storage/sqlite/SqliteConversationRepository.js';
import { SqliteMemoryRepository } from '../storage/sqlite/SqliteMemoryRepository.js';
import { SqliteTranscriptRepository } from '../storage/sqlite/SqliteTranscriptRepository.js';
import { createMemoryMcpServer } from './server.js';

dotenv.config({ quiet: true });

async function main(): Promise<void> {
  const databasePath = process.env.DATABASE_PATH?.trim() || './data/bot.db';
  const memoryDatabasePath = process.env.MEMORY_DATABASE_PATH?.trim() || './data/memories.db';
  const db = openDatabase(databasePath);
  const memoryDb = openMemoryDatabase(memoryDatabasePath);
  const server = createMemoryMcpServer({
    transcripts: new SqliteTranscriptRepository(db),
    conversations: new SqliteConversationRepository(db),
    memories: new SqliteMemoryRepository(memoryDb),
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`discord-memory MCP server running on stdio (databases: ${databasePath}, ${memoryDatabasePath})\n`);

  const shutdown = async () => {
    await server.close();
    db.close();
    memoryDb.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(`memory MCP server failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
