import { z } from 'zod';
import type { JsonObjectSchema, ToolContext, ToolDefinition, ToolProvider, ToolResult } from './types.js';

/** An in-process tool whose input is described and validated by a Zod object schema. */
export interface NativeTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  input: S;
  run(input: z.infer<S>, context: ToolContext): Promise<ToolResult | string>;
}

export function defineTool<S extends z.ZodObject>(tool: NativeTool<S>): NativeTool<S> {
  return tool;
}

/** Converts a Zod object schema to the JSON Schema shape Claude expects in `input_schema`. */
export function toInputSchema(schema: z.ZodObject): JsonObjectSchema {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
  delete json.$schema;
  return { ...json, type: 'object' } as JsonObjectSchema;
}

/** Exposes a fixed set of native tools as a ToolProvider. */
export class NativeToolProvider implements ToolProvider {
  private readonly tools: Map<string, NativeTool>;
  private readonly definitions: ToolDefinition[];

  constructor(
    readonly id: string,
    tools: readonly NativeTool[],
  ) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.definitions = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toInputSchema(tool.input),
    }));
  }

  listTools(): readonly ToolDefinition[] {
    return this.definitions;
  }

  async callTool(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { content: `Unknown tool "${name}".`, isError: true };
    // Inputs arrive through eager input streaming, which the API doesn't validate, so validate here.
    const parsed = tool.input.safeParse(input ?? {});
    if (!parsed.success) {
      return {
        content: `Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`,
        isError: true,
      };
    }
    const result = await tool.run(parsed.data, context);
    return typeof result === 'string' ? { content: result } : result;
  }
}
