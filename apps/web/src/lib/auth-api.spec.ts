import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAuthStatus, fetchAuthToken, login } from './auth-api';

describe('auth-api', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchAuthStatus returns the JSON body', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ authenticated: true }),
    });
    await expect(fetchAuthStatus()).resolves.toEqual({ authenticated: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/status');
  });

  it('fetchAuthStatus throws on non-OK', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchAuthStatus()).rejects.toThrow('Failed to check auth status (500)');
  });

  it('fetchAuthToken returns token info', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'abc', source: 'generated' }),
    });
    await expect(fetchAuthToken()).resolves.toEqual({
      token: 'abc',
      source: 'generated',
    });
  });

  it('login maps 401 to Invalid access token', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await expect(login('bad')).rejects.toThrow('Invalid access token');
  });

  it('login throws on other failures and succeeds on OK', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(login('x')).rejects.toThrow('Login failed (503)');

    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await expect(login('good')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'good' }),
    });
  });
});
