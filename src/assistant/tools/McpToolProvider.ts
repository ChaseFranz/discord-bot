import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { JsonObjectSchema, ToolContext, ToolDefinition, ToolProvider, ToolResult } from './types.js';

/** Maps a hidden tool parameter to the value the harness supplies for it. */
export type ScopeBindings = Record<string, (context: ToolContext) => string>;

/**
 * Adapts tools from an MCP server for the assistant.
 *
 * Parameters named in `scopeBindings` (e.g. guild_id, user_id) are removed from the schemas the
 * model sees and always filled in from the ToolContext, overriding anything the model sends.
 * That keeps the MCP server generic while making cross-guild or cross-user reads impossible
 * from inside a conversation.
 */
export class McpToolProvider implements ToolProvider {
  private definitions: ToolDefinition[] = [];
  private readonly hiddenParamsByTool = new Map<string, string[]>();

  private constructor(
    readonly id: string,
    private readonly client: Client,
    private readonly scopeBindings: ScopeBindings,
  ) {}

  /** Lists the server's tools once; the list is then fixed for prompt-cache stability. */
  static async connect(id: string, client: Client, scopeBindings: ScopeBindings): Promise<McpToolProvider> {
    const provider = new McpToolProvider(id, client, scopeBindings);
    await provider.loadTools();
    return provider;
  }

  private async loadTools(): Promise<void> {
    const definitions: ToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      for (const tool of page.tools) {
        const { schema, hidden } = this.hideScopeParams(tool.inputSchema as JsonObjectSchema);
        this.hiddenParamsByTool.set(tool.name, hidden);
        definitions.push({
          name: tool.name,
          description: tool.description ?? tool.title ?? tool.name,
          inputSchema: schema,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    this.definitions = definitions;
  }

  private hideScopeParams(schema: JsonObjectSchema): { schema: JsonObjectSchema; hidden: string[] } {
    const properties = { ...(schema.properties ?? {}) };
    const hidden = Object.keys(this.scopeBindings).filter((param) => param in properties);
    for (const param of hidden) delete properties[param];
    const required = (schema.required ?? []).filter((param) => !hidden.includes(param));
    const { $schema: _ignored, ...rest } = schema;
    return {
      schema: { ...rest, type: 'object', properties, ...(required.length > 0 ? { required } : { required: [] }) },
      hidden,
    };
  }

  listTools(): readonly ToolDefinition[] {
    return this.definitions;
  }

  async callTool(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const hidden = this.hiddenParamsByTool.get(name);
    if (!hidden) return { content: `Unknown tool "${name}".`, isError: true };

    const args: Record<string, unknown> =
      input !== null && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
    for (const param of hidden) {
      args[param] = this.scopeBindings[param]!(context);
    }

    const result = await this.client.callTool({ name, arguments: args });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((item: { type: string; text?: string }) => (item.type === 'text' && typeof item.text === 'string' ? item.text : `[${item.type} content omitted]`))
      .join('\n')
      .trim();
    return { content: text.length > 0 ? text : '(no output)', isError: result.isError === true };
  }
}
