import type { JsonRpcFailure, JsonRpcRequest, JsonRpcResponse, McpToolDefinition } from './types';
import type { McpRuntime } from './runtime';

const JSON_RPC_VERSION = '2.0' as const;
const PROTOCOL_VERSION = '2025-06-18';

export async function handleJsonRpcMessage(
  runtime: McpRuntime,
  message: JsonRpcRequest,
): Promise<JsonRpcResponse | undefined> {
  if (!isRequest(message)) return failure(null, -32600, 'Invalid Request');
  if (message.id === undefined && message.method.startsWith('notifications/')) return undefined;
  try {
    const result = await dispatch(runtime, message);
    if (message.id === undefined) return undefined;
    return { jsonrpc: JSON_RPC_VERSION, id: message.id, result };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return failure(message.id ?? null, -32603, text);
  }
}

async function dispatch(runtime: McpRuntime, message: JsonRpcRequest): Promise<unknown> {
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: requestedProtocol(message.params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'nuncio-mcp', version: '0.1.0' },
      };
    case 'tools/list':
      return { tools: runtime.listTools().map(publicTool) };
    case 'tools/call': {
      const params = asObject(message.params);
      const name = params.name;
      if (typeof name !== 'string') throw new Error('tools/call params.name is required');
      return runtime.callTool(name, params.arguments);
    }
    default:
      throw new Error(`Method not found: ${message.method}`);
  }
}

function publicTool(tool: McpToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function requestedProtocol(params: unknown): string {
  const requested = asObject(params).protocolVersion;
  return typeof requested === 'string' ? requested : PROTOCOL_VERSION;
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === JSON_RPC_VERSION &&
    typeof (value as { method?: unknown }).method === 'string'
  );
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function failure(id: string | number | null, code: number, message: string): JsonRpcFailure {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } };
}
