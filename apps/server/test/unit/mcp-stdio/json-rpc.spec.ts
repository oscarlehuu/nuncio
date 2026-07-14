import { describe, expect, it } from 'bun:test';
import { handleJsonRpcMessage } from '../../../src/mcp-stdio/json-rpc';
import type { JsonRpcFailure, JsonRpcResponse, JsonRpcSuccess, McpToolDefinition } from '../../../src/mcp-stdio/types';
import type { McpRuntime } from '../../../src/mcp-stdio/runtime';

function stubRuntime(overrides: Partial<McpRuntime> = {}): McpRuntime {
  const tools: McpToolDefinition[] = [
    {
      name: 'demo_tool',
      description: 'A demo tool',
      inputSchema: { type: 'object' },
    },
  ];
  return {
    listTools: () => tools,
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    ...overrides,
  };
}

function expectSuccess(response: JsonRpcResponse | undefined): JsonRpcSuccess {
  expect(response).toBeDefined();
  expect(response && 'result' in response).toBe(true);
  return response as JsonRpcSuccess;
}

function expectFailure(response: JsonRpcResponse | undefined): JsonRpcFailure {
  expect(response).toBeDefined();
  expect(response && 'error' in response).toBe(true);
  return response as JsonRpcFailure;
}

describe('handleJsonRpcMessage', () => {
  it('rejects invalid JSON-RPC requests', async () => {
    const response = await handleJsonRpcMessage(stubRuntime(), {
      jsonrpc: '1.0',
      id: 1,
      method: 'initialize',
    } as never);

    const failure = expectFailure(response);
    expect(failure.id).toBeNull();
    expect(failure.error.code).toBe(-32600);
    expect(failure.error.message).toBe('Invalid Request');
  });

  it('returns undefined for notifications without an id', async () => {
    const response = await handleJsonRpcMessage(stubRuntime(), {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    expect(response).toBeUndefined();
  });

  it('answers initialize with the requested protocol version', async () => {
    const response = await handleJsonRpcMessage(stubRuntime(), {
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });

    expect(expectSuccess(response).result).toEqual({
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'nuncio-mcp', version: '0.1.0' },
    });
  });

  it('defaults initialize protocol when params omit protocolVersion', async () => {
    const response = await handleJsonRpcMessage(stubRuntime(), {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {},
    });

    expect((expectSuccess(response).result as { protocolVersion: string }).protocolVersion).toBe(
      '2025-06-18',
    );
  });

  it('lists public tool metadata from the runtime', async () => {
    const response = await handleJsonRpcMessage(stubRuntime(), {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    });

    expect(expectSuccess(response).result).toEqual({
      tools: [
        {
          name: 'demo_tool',
          description: 'A demo tool',
          inputSchema: { type: 'object' },
        },
      ],
    });
  });

  it('dispatches tools/call to the runtime', async () => {
    const runtime = stubRuntime({
      callTool: async (name, input) => {
        expect(name).toBe('demo_tool');
        expect(input).toEqual({ foo: 'bar' });
        return { content: [{ type: 'text', text: 'called' }] };
      },
    });

    const response = await handleJsonRpcMessage(runtime, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'demo_tool', arguments: { foo: 'bar' } },
    });

    expect(expectSuccess(response).result).toEqual({
      content: [{ type: 'text', text: 'called' }],
    });
  });

  it('returns an internal error when tools/call omits params.name', async () => {
    const response = await handleJsonRpcMessage(stubRuntime(), {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { arguments: {} },
    });

    const failure = expectFailure(response);
    expect(failure.id).toBe(5);
    expect(failure.error.code).toBe(-32603);
    expect(failure.error.message).toBe('tools/call params.name is required');
  });

  it('returns an internal error for unknown methods', async () => {
    const response = await handleJsonRpcMessage(stubRuntime(), {
      jsonrpc: '2.0',
      id: 6,
      method: 'resources/list',
    });

    const failure = expectFailure(response);
    expect(failure.error.code).toBe(-32603);
    expect(failure.error.message).toBe('Method not found: resources/list');
  });

  it('maps runtime throws to JSON-RPC internal errors', async () => {
    const runtime = stubRuntime({
      callTool: async () => {
        throw new Error('boom');
      },
    });

    const response = await handleJsonRpcMessage(runtime, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'demo_tool', arguments: {} },
    });

    const failure = expectFailure(response);
    expect(failure.error.code).toBe(-32603);
    expect(failure.error.message).toBe('boom');
  });
});
