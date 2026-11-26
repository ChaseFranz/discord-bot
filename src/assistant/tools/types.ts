import type { Modality } from '../../storage/ports.js';

/** JSON Schema for a tool's input object, as sent to Claude in `input_schema`. */
export interface JsonObjectSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** Mutable flags a tool can set for the turn it runs in. */
export interface TurnSignals {
  /** Set by stop_speaking: don't voice a reply for this turn. */
  silenceRequested: boolean;
}

/** Who a tool call is acting for. Filled in by the harness, never by the model. */
export interface ToolContext {
  guildId: string;
  userId: string;
  userDisplayName: string;
  modality: Modality;
  /** Voice channel the requesting person is in right now, if any. */
  voiceChannelId: string | undefined;
  signals: TurnSignals;
}

/**
 * A source of tools for the assistant. Implementations: native in-process tools
 * (music, voice control) and MCP servers (memory). Tool lists must be stable for the
 * life of the process: the tools array is the very start of the prompt-cache prefix.
 */
export interface ToolProvider {
  readonly id: string;
  listTools(): readonly ToolDefinition[];
  callTool(name: string, input: unknown, context: ToolContext): Promise<ToolResult>;
}
