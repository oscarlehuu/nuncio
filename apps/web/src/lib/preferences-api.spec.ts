import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPreference, setPreference } from './preferences-api';

describe('preferences-api', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the preference value on success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ value: 'compact', updatedAt: 1 }),
    });
    await expect(getPreference('density')).resolves.toBe('compact');
    expect(fetchMock).toHaveBeenCalledWith('/api/preferences/density');
  });

  it('returns null on non-OK, empty body, or network errors', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(getPreference('density')).resolves.toBeNull();

    fetchMock.mockResolvedValue({ ok: true, json: async () => null });
    await expect(getPreference('density')).resolves.toBeNull();

    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(getPreference('density')).resolves.toBeNull();
  });

  it('encodes the key and swallows setPreference failures', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await setPreference('a/b', 'x');
    expect(fetchMock).toHaveBeenCalledWith('/api/preferences/a%2Fb', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'x' }),
    });

    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(setPreference('density', 'compact')).resolves.toBeUndefined();
  });
});
