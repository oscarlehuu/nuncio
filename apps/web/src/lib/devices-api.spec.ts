import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listDevices, revokeDevice, startPairing } from './devices-api';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

describe('devices-api', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('startPairing POSTs /api/pairing/start and returns the payload', async () => {
    const payload = {
      code: 'ABC123',
      expiresAt: Date.now() + 300_000,
      urls: ['https://host.ts.net'],
      hints: ['Scan with Expo Go'],
    };
    fetchMock.mockResolvedValue(jsonRes(payload));

    await expect(startPairing()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/pairing/start', { method: 'POST' });
  });

  it('startPairing throws on non-OK', async () => {
    fetchMock.mockResolvedValue(jsonRes(null, false, 503));
    await expect(startPairing()).rejects.toThrow('Failed to start pairing (503)');
  });

  it('listDevices GETs /api/devices and returns the list', async () => {
    const devices = [
      {
        id: 'dev-1',
        name: 'iPhone',
        platform: 'ios',
        createdAt: 1,
        lastSeenAt: 2,
        revoked: false,
      },
    ];
    fetchMock.mockResolvedValue(jsonRes(devices));

    await expect(listDevices()).resolves.toEqual(devices);
    expect(fetchMock).toHaveBeenCalledWith('/api/devices');
  });

  it('listDevices throws on non-OK', async () => {
    fetchMock.mockResolvedValue(jsonRes(null, false, 500));
    await expect(listDevices()).rejects.toThrow('Failed to load devices (500)');
  });

  it('revokeDevice DELETEs /api/devices/:id', async () => {
    fetchMock.mockResolvedValue(jsonRes(null));
    await expect(revokeDevice('dev/special')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/devices/dev%2Fspecial', { method: 'DELETE' });
  });

  it('revokeDevice throws on non-OK', async () => {
    fetchMock.mockResolvedValue(jsonRes(null, false, 404));
    await expect(revokeDevice('missing')).rejects.toThrow('Failed to revoke device (404)');
  });
});
