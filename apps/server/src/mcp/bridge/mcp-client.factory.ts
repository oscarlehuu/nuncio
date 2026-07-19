import { Injectable } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { McpTransport } from '../domain/mcp.types';
import type {
  McpBridgeClient,
  McpCallContent,
  McpClientFactory,
  McpToolDescriptor,
} from './mcp-client.types';

/**
 * Real MCP client factory on `@modelcontextprotocol/sdk`. stdio servers are
 * spawned as child processes (with the SDK's default env allowlist merged
 * under the configured env); `http` uses the Streamable HTTP transport and
 * `sse` the legacy SSE transport. OAuth-protected remotes are phase 2 — a 401
 * here surfaces as a per-call error through the bridge's failure containment.
 */
@Injectable()
export class SdkMcpClientFactory implements McpClientFactory {
  async connect(transport: McpTransport): Promise<McpBridgeClient> {
    const client = new Client({ name: 'nuncio-mcp-store', version: '1.0.0' });
    await client.connect(buildSdkTransport(transport));
    return {
      async listTools(): Promise<McpToolDescriptor[]> {
        const result = await client.listTools();
        return result.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
        }));
      },
      async callTool(name, args) {
        const result = await client.callTool({ name, arguments: args });
        const rawContent = Array.isArray(result.content) ? result.content : [];
        const content = rawContent.map((entry): McpCallContent => {
          if (entry.type === 'text') return { type: 'text', text: entry.text };
          if (entry.type === 'image') {
            return { type: 'image', data: entry.data, mimeType: entry.mimeType };
          }
          return { type: 'text', text: JSON.stringify(entry) };
        });
        return {
          content,
          ...(result.structuredContent !== undefined
            ? { structuredContent: result.structuredContent }
            : {}),
          ...(result.isError ? { isError: true } : {}),
        };
      },
      async close() {
        await client.close();
      },
    };
  }
}

function buildSdkTransport(transport: McpTransport) {
  if (transport.type === 'stdio') {
    return new StdioClientTransport({
      command: transport.command,
      args: transport.args,
      env: { ...getDefaultEnvironment(), ...(transport.env ?? {}) },
      ...(transport.cwd ? { cwd: transport.cwd } : {}),
      stderr: 'ignore',
    });
  }
  const url = new URL(transport.url);
  const requestInit = transport.headers ? { headers: transport.headers } : undefined;
  if (transport.type === 'sse') {
    return new SSEClientTransport(url, requestInit ? { requestInit } : undefined);
  }
  return new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
}
