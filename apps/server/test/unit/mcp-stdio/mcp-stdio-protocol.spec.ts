import { describe, expect, it } from 'bun:test';
import { handleJsonRpcMessage } from '../../../src/mcp-stdio/json-rpc';
import { createMcpRuntime } from '../../../src/mcp-stdio/runtime';
import type { JsonRpcResponse, JsonRpcSuccess } from '../../../src/mcp-stdio/types';

type StubFetch = (request: Request) => Response | Promise<Response>;
const stubFetch = (handler: StubFetch) =>
  ((input, init) => handler(new Request(input, init))) as typeof fetch;

function expectSuccess(response: JsonRpcResponse | undefined): JsonRpcSuccess {
  expect(response).toBeDefined();
  expect(response && 'result' in response).toBe(true);
  return response as JsonRpcSuccess;
}

describe('nuncio MCP stdio JSON-RPC protocol', () => {
  it('answers initialize with a tools-only MCP server capability', async () => {
    const runtime = createMcpRuntime({ apiOrigin: 'http://127.0.0.1:3000' });

    const response = await handleJsonRpcMessage(runtime, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'nuncio-mcp', version: expect.any(String) },
      },
    });
  });

  it('lists the agent-readable Nuncio tools with input schemas', async () => {
    const runtime = createMcpRuntime({ apiOrigin: 'http://127.0.0.1:3000' });
    const response = await handleJsonRpcMessage(runtime, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    const result = expectSuccess(response).result as { tools: Array<{ name: string }> };
    expect(result.tools.map((tool) => tool.name)).toEqual([
      'nuncio_list_sessions',
      'nuncio_get_session',
      'nuncio_get_timeline',
      'nuncio_get_attention',
      'nuncio_get_fleet',
      'nuncio_list_loops',
      'nuncio_enqueue_task',
      'nuncio_pause_loop',
    ]);
    expect(result.tools[0]).toEqual(
      expect.objectContaining({
        description: expect.stringContaining('List Nuncio sessions'),
        inputSchema: expect.objectContaining({ type: 'object' }),
      }),
    );
  });

  it('calls a read tool against the daemon API and returns structured content', async () => {
    const fetchImpl = stubFetch((request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe('/api/sessions');
      expect(url.searchParams.get('includeArchived')).toBe('1');
      return Response.json([{ id: 's1', status: 'IDLE' }]);
    });
    const runtime = createMcpRuntime({ apiOrigin: 'http://127.0.0.1:3000', fetchImpl });

    const response = await handleJsonRpcMessage(runtime, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'nuncio_list_sessions',
        arguments: { includeArchived: true },
      },
    });

    expect(expectSuccess(response).result).toMatchObject({
      structuredContent: { sessions: [{ id: 's1', status: 'IDLE' }] },
      content: [{ type: 'text', text: expect.stringContaining('"id": "s1"') }],
    });
  });

  it('surfaces daemon failures as MCP tool errors without leaking tokens', async () => {
    const fetchImpl = stubFetch(() =>
      Response.json({ message: 'Bearer secret-token failed for NUNCIO_AUTH_TOKEN=secret-token' }, { status: 503 }),
    );
    const runtime = createMcpRuntime({
      apiOrigin: 'http://127.0.0.1:3000',
      authToken: 'secret-token',
      fetchImpl,
    });

    const response = await handleJsonRpcMessage(runtime, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'nuncio_get_fleet', arguments: {} },
    });

    const result = expectSuccess(response).result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[redacted]');
    expect(result.content[0].text).not.toContain('secret-token');
  });
});
