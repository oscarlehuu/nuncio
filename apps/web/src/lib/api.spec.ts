import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FALLBACK_PROVIDERS, normalizeModelCatalog } from './model-providers';
import {
  archiveSession,
  createSession,
  deleteSession,
  fetchArchivedSessions,
  fetchModels,
  fetchSession,
  fetchSessions,
  pauseSession,
  relativeTime,
  restoreSession,
  statusLabel,
  steerSession,
} from './api';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

describe('statusLabel', () => {
  it('labels every known status', () => {
    expect(statusLabel('CREATED')).toBe('Created');
    expect(statusLabel('RUNNING')).toBe('Running');
    expect(statusLabel('IDLE')).toBe('Idle');
    expect(statusLabel('PAUSED')).toBe('Paused');
    expect(statusLabel('ARCHIVED')).toBe('Archived');
    expect(statusLabel('ERROR')).toBe('Error');
  });

  it('falls back to the raw status for unknown values', () => {
    expect(statusLabel('WEIRD' as never)).toBe('WEIRD');
  });
});

describe('relativeTime', () => {
  it('returns "just now" under 1m', () => {
    expect(relativeTime(Date.now() - 5_000)).toBe('just now');
  });
  it('returns "Xm ago" under 1h', () => {
    expect(relativeTime(Date.now() - 5 * 60_000)).toBe('5m ago');
  });
  it('returns "Xh ago" under 1d', () => {
    expect(relativeTime(Date.now() - 3 * 3_600_000)).toBe('3h ago');
  });
  it('returns "Xd ago" beyond 1d', () => {
    expect(relativeTime(Date.now() - 2 * 86_400_000)).toBe('2d ago');
  });
});

describe('api fetch functions', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createSession posts prompt + model + provider', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 's1' }));
    await createSession('do thing', 'm1', 'pi');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ prompt: 'do thing', model: 'm1', provider: 'pi' }),
      }),
    );
  });

  it('createSession omits model/provider when not provided', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 's2' }));
    await createSession('just prompt');
    const call = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(call.body as string)).toEqual({ prompt: 'just prompt' });
  });

  it('createSession posts modelOptions when provided', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 's3' }));
    await createSession('go', 'cursor:composer-2.5', 'cursor', undefined, undefined, {
      fast: true,
    });
    const call = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(call.body as string)).toEqual({
      prompt: 'go',
      model: 'cursor:composer-2.5',
      provider: 'cursor',
      modelOptions: { fast: true },
    });
  });

  it('fetchSessions parses the JSON list', async () => {
    fetchMock.mockResolvedValue(jsonRes([{ id: 'a' }]));
    expect(await fetchSessions()).toEqual([{ id: 'a' }]);
  });

  it('fetchSessions throws when the response is not ok', async () => {
    fetchMock.mockResolvedValue(jsonRes(null, false, 500));
    await expect(fetchSessions()).rejects.toThrow('Failed to load sessions');
  });

  it('fetchSession parses a single session', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 's1', title: 'Test' }));
    expect(await fetchSession('s1')).toEqual({ id: 's1', title: 'Test' });
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1');
  });

  it('fetchSession throws when the response is not ok', async () => {
    fetchMock.mockResolvedValue(jsonRes(null, false, 404));
    await expect(fetchSession('missing')).rejects.toThrow('Failed to load session');
  });

  it('fetchModels returns the array from a 200 response', async () => {
    fetchMock.mockResolvedValue(jsonRes([{ id: 'pi' }]));
    expect(await fetchModels()).toEqual([{ id: 'pi' }]);
  });

  it('fetchModels unwraps { providers: [...] } responses', async () => {
    fetchMock.mockResolvedValue(jsonRes({ providers: [{ id: 'pi' }] }));
    expect(await fetchModels()).toEqual([{ id: 'pi' }]);
  });

  it('fetchModels falls back to normalized FALLBACK_PROVIDERS when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    expect(await fetchModels()).toEqual(normalizeModelCatalog(FALLBACK_PROVIDERS));
  });

  it('fetchModels falls back when the response is not ok', async () => {
    fetchMock.mockResolvedValue(jsonRes(null, false, 503));
    expect(await fetchModels()).toEqual(normalizeModelCatalog(FALLBACK_PROVIDERS));
  });

  it('steer / pause / archive hit the right POST endpoints', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 's1' }));
    await steerSession('s1', 'more');
    await pauseSession('s1');
    await archiveSession('s1');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/sessions/s1/steer',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/sessions/s1/pause',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/sessions/s1/archive',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('fetchArchivedSessions requests the includeArchived flag', async () => {
    fetchMock.mockResolvedValue(jsonRes([{ id: 'a1', status: 'ARCHIVED' }]));
    const list = await fetchArchivedSessions();
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions?includeArchived=1');
    expect(list).toEqual([{ id: 'a1', status: 'ARCHIVED' }]);
  });

  it('fetchArchivedSessions filters out non-archived sessions', async () => {
    fetchMock.mockResolvedValue(
      jsonRes([
        { id: 'a1', status: 'ARCHIVED' },
        { id: 'b2', status: 'IDLE' },
        { id: 'a3', status: 'ARCHIVED' },
      ]),
    );
    const list = await fetchArchivedSessions();
    expect(list.map((s) => s.id)).toEqual(['a1', 'a3']);
  });

  it('fetchArchivedSessions throws when the response is not ok', async () => {
    fetchMock.mockResolvedValue(jsonRes(null, false, 500));
    await expect(fetchArchivedSessions()).rejects.toThrow('Failed to load archived sessions');
  });

  it('restoreSession posts to the restore endpoint', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 's1', status: 'IDLE' }));
    await restoreSession('s1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/s1/restore',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('deleteSession sends a DELETE request', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true }));
    await deleteSession('s1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/s1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('deleteSession throws when the response is not ok', async () => {
    fetchMock.mockResolvedValue(jsonRes(null, false, 400));
    await expect(deleteSession('s1')).rejects.toThrow('Failed to delete session');
  });
});
