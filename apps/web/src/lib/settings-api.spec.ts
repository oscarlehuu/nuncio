import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  clearSetting,
  fetchSettings,
  updateSetting,
  type Setting,
} from './settings-api';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

function makeSetting(over: Partial<Setting> = {}): Setting {
  return {
    key: 'CURSOR_API_KEY',
    category: 'provider',
    providerId: 'cursor',
    type: 'secret',
    label: 'Cursor API Key',
    description: 'd',
    hasValue: false,
    source: null,
    value: null,
    readOnly: false,
    ...over,
  };
}

describe('settings-api', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchSettings GETs /api/settings and returns the list', async () => {
    fetchMock.mockResolvedValue(jsonRes([makeSetting({ key: 'A' }), makeSetting({ key: 'B' })]));
    const settings = await fetchSettings();
    expect(settings).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith('/api/settings');
  });

  it('fetchSettings throws when the response is not ok', async () => {
    fetchMock.mockResolvedValue(jsonRes(null, false, 500));
    await expect(fetchSettings()).rejects.toThrow('Failed to load settings');
  });

  it('updateSetting PUTs { value } to /api/settings/:key and returns the DTO', async () => {
    const updated = makeSetting({ hasValue: true, source: 'db', value: '••••12ab' });
    fetchMock.mockResolvedValue(jsonRes(updated));
    const result = await updateSetting('CURSOR_API_KEY', 'sk-new');
    expect(result).toEqual(updated);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/CURSOR_API_KEY',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ value: 'sk-new' }),
      }),
    );
  });

  it('updateSetting throws when the response is not ok', async () => {
    fetchMock.mockResolvedValue(jsonRes({ message: 'bad' }, false, 400));
    await expect(updateSetting('NOPE', 'x')).rejects.toThrow('Failed to update setting');
  });

  it('clearSetting DELETEs /api/settings/:key and returns the resulting DTO', async () => {
    const after = makeSetting({ hasValue: false, source: null, value: null });
    fetchMock.mockResolvedValue(jsonRes(after));
    const result = await clearSetting('CURSOR_API_KEY');
    expect(result).toEqual(after);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/CURSOR_API_KEY',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('clearSetting throws when the response is not ok', async () => {
    fetchMock.mockResolvedValue(jsonRes(null, false, 404));
    await expect(clearSetting('NOPE')).rejects.toThrow('Failed to clear setting');
  });
});
