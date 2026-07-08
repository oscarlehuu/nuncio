import { describe, expect, it } from 'bun:test';
import { handleJsonRpcMessage } from '../../../src/mcp-stdio/json-rpc';
import { createMcpRuntime } from '../../../src/mcp-stdio/runtime';
import { MCP_TOOLS, MUTATION_TOOL_NAMES } from '../../../src/mcp-stdio/tool-definitions';
import type { JsonRpcResponse, JsonRpcSuccess } from '../../../src/mcp-stdio/types';

type StubFetch = (request: Request) => Response | Promise<Response>;
const stubFetch = (handler: StubFetch) =>
  ((input, init) => handler(new Request(input, init))) as typeof fetch;

function expectSuccess(response: JsonRpcResponse | undefined): JsonRpcSuccess {
  expect(response).toBeDefined();
  expect(response && 'result' in response).toBe(true);
  return response as JsonRpcSuccess;
}

describe('nuncio MCP mutation safety rails', () => {
  it('registers exactly the constrained mutation tools', () => {
    const registeredMutations = MCP_TOOLS.filter((tool) => tool.mutation).map((tool) => tool.name);

    expect(MUTATION_TOOL_NAMES).toEqual(['nuncio_enqueue_task', 'nuncio_pause_loop']);
    expect(registeredMutations).toEqual(MUTATION_TOOL_NAMES);
    expect(MCP_TOOLS.map((tool) => tool.name).join(' ')).not.toMatch(
      /archive|delete|settings|restore|cancel|retry/i,
    );
  });

  it('enqueues a task through the existing task API and returns what happened', async () => {
    const fetchImpl = stubFetch(async (request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe('/api/tasks');
      expect(request.method).toBe('POST');
      expect(await request.json()).toEqual({
        prompt: 'Ship rung 4',
        provider: 'codex',
        projectPath: '/repo/nuncio',
        useWorktree: true,
      });
      return Response.json({ id: 't1', status: 'QUEUED', prompt: 'Ship rung 4' });
    });
    const runtime = createMcpRuntime({ apiOrigin: 'http://127.0.0.1:3000', fetchImpl });

    const response = await handleJsonRpcMessage(runtime, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'nuncio_enqueue_task',
        arguments: {
          prompt: '  Ship rung 4  ',
          provider: 'codex',
          projectPath: '/repo/nuncio',
          useWorktree: true,
        },
      },
    });

    const result = expectSuccess(response).result as { structuredContent: unknown };
    expect(result.structuredContent).toEqual({
      action: 'enqueued',
      task: { id: 't1', status: 'QUEUED', prompt: 'Ship rung 4' },
    });
  });

  it('maps enqueue validation errors to MCP tool errors', async () => {
    const runtime = createMcpRuntime({ apiOrigin: 'http://127.0.0.1:3000' });

    const response = await handleJsonRpcMessage(runtime, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'nuncio_enqueue_task', arguments: { prompt: '   ' } },
    });

    expect(expectSuccess(response).result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'prompt is required' }],
    });
  });

  it('pauses an existing loop through the daemon API and returns what happened', async () => {
    const fetchImpl = stubFetch((request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe('/api/loops/loop-1/pause');
      expect(request.method).toBe('POST');
      return Response.json({ id: 'loop-1', status: 'paused' });
    });
    const runtime = createMcpRuntime({ apiOrigin: 'http://127.0.0.1:3000', fetchImpl });

    const response = await handleJsonRpcMessage(runtime, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'nuncio_pause_loop', arguments: { loopId: 'loop-1' } },
    });

    const result = expectSuccess(response).result as { structuredContent: unknown };
    expect(result.structuredContent).toEqual({
      action: 'paused',
      loop: { id: 'loop-1', status: 'paused' },
    });
  });
});
