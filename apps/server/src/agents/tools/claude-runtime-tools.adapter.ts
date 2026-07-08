import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import {
  asToolInput,
  normalizeAgentRuntimeToolResult,
  type AgentRuntimeToolResult,
  type AgentRuntimeTools,
} from './agent-runtime-tools.types';

/** The in-process SDK MCP server name; the tool_use prefix `mcp__<this>__` is stripped for display. */
export const CLAUDE_RUNTIME_MCP_SERVER = 'nuncio-runtime';

/** A CallToolResult content block — the subset the SDK MCP transport carries. */
type McpToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

interface McpCallToolResult {
  content: McpToolContent[];
  isError?: boolean;
  structuredContent?: unknown;
}

/**
 * One SDK MCP tool definition. `createSdkMcpServer` demands a Zod raw shape and
 * rejects a JSON Schema at runtime, so nuncio's JSON-Schema tool inputs are
 * converted to a Zod raw shape by `jsonSchemaToZodShape` below. The converter is
 * deliberately narrow — it covers only the primitive shapes nuncio's own tool
 * contract uses (string/number/boolean/integer/array/enum, required vs optional)
 * — because the alternative (an empty shape) hides every parameter from the
 * model and breaks tools that take real arguments (e.g. the browser tools' url).
 */
export interface ClaudeMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  handler: (args: unknown) => Promise<McpCallToolResult>;
}

/** The shape `createSdkMcpServer` returns; the provider passes it straight into `mcpServers`. */
export interface ClaudeMcpServerConfig {
  type: 'sdk';
  name: string;
  instance: unknown;
}

/** Injected so specs can build the server without importing the real SDK. */
export type CreateSdkMcpServer = (options: {
  name: string;
  version?: string;
  tools: ClaudeMcpToolDefinition[];
}) => ClaudeMcpServerConfig;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Convert one JSON-Schema property node to a Zod type. Unknown / unsupported
 * node shapes fall back to `z.any()` so the tool still works — an over-permissive
 * arg is far better than dropping the parameter entirely.
 */
function propertyToZod(node: unknown): ZodTypeAny {
  if (!isRecord(node)) return z.any();

  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const literals = node.enum.map((value) => z.literal(value as never));
    const base =
      literals.length === 1
        ? literals[0]
        : z.union(literals as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
    return describe(base, node.description);
  }

  switch (node.type) {
    case 'string':
      return describe(z.string(), node.description);
    case 'number':
    case 'integer':
      return describe(z.number(), node.description);
    case 'boolean':
      return describe(z.boolean(), node.description);
    case 'array':
      return describe(z.array(propertyToZod(node.items)), node.description);
    case 'object':
      return describe(z.object(jsonSchemaToZodShape(node)), node.description);
    default:
      return describe(z.any(), node.description);
  }
}

function describe(schema: ZodTypeAny, description: unknown): ZodTypeAny {
  return typeof description === 'string' ? schema.describe(description) : schema;
}

/**
 * Convert a JSON-Schema object node into a Zod raw shape. Non-required fields
 * become `.optional()`. A schema with no `properties` yields an empty shape,
 * which the SDK accepts and which still forwards any model-supplied args to the
 * handler untouched.
 */
export function jsonSchemaToZodShape(schema: Record<string, unknown>): ZodRawShape {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const shape: ZodRawShape = {};
  for (const [key, node] of Object.entries(properties)) {
    const zodType = propertyToZod(node);
    shape[key] = required.has(key) ? zodType : zodType.optional();
  }
  return shape;
}

function toMcpResult(result: AgentRuntimeToolResult): McpCallToolResult {
  return {
    content: result.content as McpToolContent[],
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
  };
}

/**
 * Wrap nuncio's session-bound runtime tools as SDK MCP tool definitions. A
 * throwing `execute` is caught and surfaced as an is-error result so the model
 * sees the failure rather than the turn crashing.
 */
export function buildClaudeRuntimeToolDefinitions(
  runtimeTools?: AgentRuntimeTools,
): ClaudeMcpToolDefinition[] {
  const tools = runtimeTools?.tools ?? [];
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? tool.name,
    inputSchema: jsonSchemaToZodShape(tool.inputSchema),
    handler: async (args: unknown): Promise<McpCallToolResult> => {
      try {
        return toMcpResult(normalizeAgentRuntimeToolResult(await tool.execute(asToolInput(args))));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    },
  }));
}

/**
 * Build the `mcpServers` entry for a session's runtime tools, or undefined when
 * there are no tools (mirrors the cursor adapter's empty-input contract). The
 * server is created at query construction so first turn and resume see an
 * identical toolset.
 */
export function buildClaudeMcpServers(
  createServer: CreateSdkMcpServer,
  runtimeTools?: AgentRuntimeTools,
): Record<string, ClaudeMcpServerConfig> | undefined {
  const definitions = buildClaudeRuntimeToolDefinitions(runtimeTools);
  if (definitions.length === 0) return undefined;
  const server = createServer({
    name: CLAUDE_RUNTIME_MCP_SERVER,
    version: '1.0.0',
    tools: definitions,
  });
  return { [CLAUDE_RUNTIME_MCP_SERVER]: server };
}

/**
 * Strip the `mcp__<server>__` prefix the SDK stamps onto in-process MCP tool
 * names so the transcript shows the bare tool name. Non-MCP names (built-in
 * Bash, Read, …) pass through unchanged.
 */
export function normalizeMcpToolName(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const rest = name.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  return sep >= 0 ? rest.slice(sep + 2) : rest;
}
