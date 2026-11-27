import type { ToolContext, ToolDefinition, ToolProvider, ToolResult } from './types.js';

/** Aggregates tool providers behind one name -> tool lookup. */
export class ToolRegistry {
  private readonly byName = new Map<string, { provider: ToolProvider; definition: ToolDefinition }>();

  constructor(providers: readonly ToolProvider[]) {
    for (const provider of providers) {
      for (const definition of provider.listTools()) {
        const existing = this.byName.get(definition.name);
        if (existing) {
          throw new Error(
            `Tool name "${definition.name}" is provided by both "${existing.provider.id}" and "${provider.id}"`,
          );
        }
        this.byName.set(definition.name, { provider, definition });
      }
    }
  }

  /** Definitions sorted by name, so the serialised tools array is byte-identical across requests. */
  definitions(): ToolDefinition[] {
    return [...this.byName.values()].map((entry) => entry.definition).sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  async call(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const entry = this.byName.get(name);
    if (!entry) return { content: `Unknown tool "${name}".`, isError: true };
    try {
      return await entry.provider.callTool(name, input, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Tool "${name}" failed: ${message}`, isError: true };
    }
  }
}
