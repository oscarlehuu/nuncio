import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchProviderUpdates, updateProviderTool } from './provider-updates-api';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

describe('provider-updates-api', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws the server message when a provider update request is rejected', async () => {
    fetchMock.mockResolvedValue(
      jsonRes({ message: 'Codex does not support one-click updates.' }, false, 400),
    );

    await expect(updateProviderTool('codex')).rejects.toThrow(
      'Codex does not support one-click updates.',
    );
  });

  it('fetches the current provider update status', async () => {
    const updates = { enabled: true, notificationsEnabled: false, providers: [] };
    fetchMock.mockResolvedValue(jsonRes(updates));

    await expect(fetchProviderUpdates()).resolves.toEqual(updates);
    expect(fetchMock).toHaveBeenCalledWith('/api/provider-updates');
  });

  it('uses the fallback when an update response has no usable message', async () => {
    fetchMock.mockResolvedValue(jsonRes({ message: '   ' }, false, 503));

    await expect(updateProviderTool('pi')).rejects.toThrow('Failed to update provider tool');
  });

  it('uses the fallback when an error response is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => {
        throw new Error('invalid json');
      },
    });

    await expect(fetchProviderUpdates()).rejects.toThrow('Failed to load provider updates');
  });

  it('returns a successful provider update result', async () => {
    const result = { provider: 'pi', status: 'unchanged', message: 'Already current' };
    fetchMock.mockResolvedValue(jsonRes(result));

    await expect(updateProviderTool('pi')).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith('/api/provider-updates/pi/update', { method: 'POST' });
  });
});
