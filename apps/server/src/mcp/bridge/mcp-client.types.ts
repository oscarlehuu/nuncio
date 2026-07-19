import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { McpTransport } from '../domain/mcp.types';

/** A tool advertised by a connected MCP server. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type McpCallContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface McpCallOutcome {
  content: McpCallContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Narrow client surface the bridge needs — real impl wraps @modelcontextprotocol/sdk. */
export interface McpBridgeClient {
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallOutcome>;
  close(): Promise<void>;
}

/** Injectable so unit tests never spawn processes or open sockets. */
export interface McpClientConnectOptions {
  authProvider?: OAuthClientProvider;
}

/** Injectable so unit tests never spawn processes or open sockets. */
export interface McpClientFactory {
  connect(transport: McpTransport, options?: McpClientConnectOptions): Promise<McpBridgeClient>;
}

export const MCP_CLIENT_FACTORY = Symbol('MCP_CLIENT_FACTORY');
