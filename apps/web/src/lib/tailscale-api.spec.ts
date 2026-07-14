import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchTailscaleStatus, pushProvision, TAILSCALE_AUTO_TRUST_KEY } from './tailscale-api';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

describe('tailscale-api', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exports the auto-trust settings key', () => {
    expect(TAILSCALE_AUTO_TRUST_KEY).toBe('NUNCIO_TAILSCALE_AUTO_TRUST');
  });

  it('fetchTailscaleStatus GETs /api/tailscale/status', async () => {
    const status = {
      installed: true,
      running: true,
      autoTrust: false,
      tailnet: 'example.ts.net',
      self: {
        hostName: 'mac',
        dnsName: 'mac.example.ts.net',
        ips: ['100.64.0.1'],
        os: 'darwin',
        loginName: 'user@example.com',
      },
      peers: [],
    };
    fetchMock.mockResolvedValue(jsonRes(status));

    await expect(fetchTailscaleStatus()).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledWith('/api/tailscale/status');
  });

  it('fetchTailscaleStatus throws on non-OK', async () => {
    fetchMock.mockResolvedValue(jsonRes(null, false, 502));
    await expect(fetchTailscaleStatus()).rejects.toThrow('Failed to load Tailscale status (502)');
  });

  it('pushProvision POSTs the target and returns the result', async () => {
    const result = {
      target: 'https://peer.ts.net',
      sent: { piFiles: ['auth.json'], settings: ['CURSOR_API_KEY'] },
      applied: {
        piFilesWritten: ['auth.json'],
        piFilesBackedUp: [],
        settingsApplied: ['CURSOR_API_KEY'],
        settingsSkipped: [],
      },
    };
    fetchMock.mockResolvedValue(jsonRes(result));

    await expect(pushProvision('https://peer.ts.net')).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith('/api/provision/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'https://peer.ts.net' }),
    });
  });

  it('pushProvision prefers server message from JSON body', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: 'Target unreachable' }),
    });
    await expect(pushProvision('bad')).rejects.toThrow('Target unreachable');
  });

  it('pushProvision falls back to status message when JSON parse fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    });
    await expect(pushProvision('bad')).rejects.toThrow('Sync failed (500)');
  });
});
