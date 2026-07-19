import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyMcpImport,
  deleteMcpServer,
  fetchMcpServers,
  previewMcpImport,
  startMcpOAuth,
  updateMcpServer,
} from './mcp-servers-api';

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

describe('mcp-servers-api', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the configured MCP servers', async () => {
    const servers = [{ id: 'server-1', name: 'Docs', enabled: true }];
    fetchMock.mockResolvedValue(response(servers));

    await expect(fetchMcpServers()).resolves.toEqual(servers);
    expect(fetchMock).toHaveBeenCalledWith('/api/mcp-servers');
  });

  it('updates and deletes an MCP server using an encoded id', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ id: 'server/a' }))
      .mockResolvedValueOnce(response(null));

    await updateMcpServer('server/a', { enabled: false, name: 'Docs' });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/mcp-servers/server%2Fa',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ enabled: false, name: 'Docs' }),
      }),
    );

    await deleteMcpServer('server/a');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/mcp-servers/server%2Fa', { method: 'DELETE' });
  });

  it('previews and applies imports with the appropriate dry-run payload', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ source: 'cursor', entries: [] }))
      .mockResolvedValueOnce(response({ source: 'cursor', createdIds: ['new'], mergedIds: [] }));

    await expect(previewMcpImport('cursor')).resolves.toEqual({ source: 'cursor', entries: [] });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/mcp-servers/import',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ source: 'cursor', dryRun: true }),
      }),
    );

    await expect(applyMcpImport('cursor')).resolves.toEqual({
      source: 'cursor',
      createdIds: ['new'],
      mergedIds: [],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/mcp-servers/import',
      expect.objectContaining({ body: JSON.stringify({ source: 'cursor' }) }),
    );
  });

  it('starts OAuth and returns authorization details', async () => {
    fetchMock.mockResolvedValue(response({ authorizationUrl: 'https://auth.example.test' }));

    await expect(startMcpOAuth('server/a')).resolves.toEqual({
      authorizationUrl: 'https://auth.example.test',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/mcp-servers/server%2Fa/oauth/start',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });

  it('uses server messages, arrays, and status codes for failed requests', async () => {
    fetchMock.mockResolvedValueOnce(response({ message: ['Invalid', 'credentials'] }, false, 401));
    await expect(fetchMcpServers()).rejects.toThrow('Invalid, credentials');

    fetchMock.mockResolvedValueOnce(response({}, false, 503));
    await expect(fetchMcpServers()).rejects.toThrow('503');
  });

  it('falls back to the status when an error response is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('invalid json');
      },
    });

    await expect(fetchMcpServers()).rejects.toThrow('502');
  });
});
