/**
 * Minimal stdio MCP server used by the bridge e2e spec. Spawned with
 * `bun <this file>` by the real SdkMcpClientFactory.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-fixture', version: '1.0.0' });

server.registerTool(
  'echo',
  {
    description: 'Echoes the given text back',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }),
);

server.registerTool(
  'workspace_root',
  {
    description: 'Returns the WORKSPACE_ROOT env var this server was started with',
    inputSchema: {},
  },
  async () => ({ content: [{ type: 'text', text: process.env.WORKSPACE_ROOT ?? '(unset)' }] }),
);

void server.connect(new StdioServerTransport());
