import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FALLBACK_PROVIDERS, normalizeModelCatalog } from './model-providers';
import {
  archiveSession,
  createSession,
  fetchModels,
  fetchSessions,
  pauseSession,
  relativeTime,
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

  it('fetchSessions parses the JSON list', async () => {
    fetchMock.mockResolvedValue(jsonRes([{ id: 'a' }]));
    expect(await fetchSessions()).toEqual([{ id: 'a' }]);
  });

  it('fetchSessions throws when the response is not ok', async () => {
    fetchMock.mockResolvedValue(jsonRes(null, false, 500));
    await expect(fetchSessions()).rejects.toThrow('Failed to load sessions');
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
});
