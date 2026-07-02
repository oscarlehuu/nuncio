import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SteerApiError,
  fetchActiveRun,
  refreshSessionTranscript,
  steerSession,
  steerErrorMessage,
} from './api';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response;
}

describe('steerSession', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws SteerApiError with mapped message on 409', async () => {
    fetchMock.mockResolvedValue(
      jsonRes({ message: 'Cursor may still be running...' }, false, 409),
    );
    await expect(steerSession('s1', 'go')).rejects.toMatchObject({
      name: 'SteerApiError',
      status: 409,
      message: steerErrorMessage(409, 'fallback'),
    });
  });

  it('passes forceResume in the request body', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 's1' }));
    await steerSession('s1', 'go', true);
    const call = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(call.body as string)).toEqual({ message: 'go', forceResume: true });
  });

  it('fetchActiveRun returns active flag', async () => {
    fetchMock.mockResolvedValue(jsonRes({ active: true }));
    expect(await fetchActiveRun('s1')).toEqual({ active: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/active-run');
  });

  it('refreshSessionTranscript posts to refresh endpoint', async () => {
    fetchMock.mockResolvedValue(jsonRes({ added: 2 }));
    expect(await refreshSessionTranscript('s1')).toEqual({ added: 2 });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/s1/refresh-transcript',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('SteerApiError', () => {
  it('carries status for instanceof checks', () => {
    const err = new SteerApiError(409, 'blocked');
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(409);
  });
});
