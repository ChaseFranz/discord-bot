import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpToolProvider } from '../assistant/tools/McpToolProvider.js';
import type { ConversationRepository, MemoryRepository, TranscriptRepository } from '../storage/ports.js';
import { SCOPE_PARAMS, createMemoryMcpServer } from './server.js';

/**
 * Runs the memory MCP server in-process and connects the assistant to it over an in-memory
 * transport. To run the server elsewhere later (a separate process, or a hosted service on AWS),
 * swap the transport here for stdio or Streamable HTTP; nothing else changes.
 */
export async function connectMemoryTools(deps: {
  transcripts: TranscriptRepository;
  conversations: ConversationRepository;
  memories: MemoryRepository;
}): Promise<{ provider: McpToolProvider; close(): Promise<void> }> {
  const server = createMemoryMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new McpClient({ name: 'discord-bot', version: '2.0.0' });
  await client.connect(clientTransport);
  const provider = await McpToolProvider.connect('memory', client, {
    [SCOPE_PARAMS.guildId]: (context) => context.guildId,
    [SCOPE_PARAMS.userId]: (context) => context.userId,
    [SCOPE_PARAMS.userName]: (context) => context.userDisplayName,
  });
  return {
    provider,
    async close() {
      await client.close();
      await server.close();
    },
  };
}
