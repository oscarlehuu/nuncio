import { describe, expect, it, vi } from 'vitest';
import { rotateDeviceSecret } from './rotate-secret';
import type { ConnectionConfig, KeyValueStore } from './connection-store';

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => {
      data.set(k, v);
    },
    delete: async (k) => {
      data.delete(k);
    },
  };
}

const deviceConfig: ConnectionConfig = {
  serverUrl: 'http://a',
  token: null,
  deviceId: 'dev-1',
  deviceSecret: 'old-secret',
};

const jsonResponse = (status: number, body: unknown): Response =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;

describe('rotateDeviceSecret', () => {
  it('skips legacy token connections with no device secret', async () => {
    const outcome = await rotateDeviceSecret({
      config: { serverUrl: 'http://a', token: 'legacy' },
      store: memoryStore(),
      fetchImpl: async () => jsonResponse(200, { deviceSecret: 'new' }),
      applySecret: () => {},
    });
    expect(outcome).toBe('skipped');
  });

  it('persists the new secret BEFORE swapping it in memory', async () => {
    const store = memoryStore();
    const events: string[] = [];
    const outcome = await rotateDeviceSecret({
      config: deviceConfig,
      store: {
        ...store,
        set: async (k, v) => {
          events.push('persist');
          await store.set(k, v);
        },
      },
      fetchImpl: async () => jsonResponse(200, { deviceSecret: 'new-secret' }),
      applySecret: () => events.push('apply'),
    });
    expect(outcome).toBe('rotated');
    expect(events).toEqual(['persist', 'apply']); // order is the whole point
    expect(JSON.parse(store.data.get('nuncio.connection')!).deviceSecret).toBe('new-secret');
  });

  it('keeps the old secret (no swap) when persistence throws', async () => {
    const apply = vi.fn();
    const outcome = await rotateDeviceSecret({
      config: deviceConfig,
      store: { ...memoryStore(), set: async () => {
        throw new Error('keychain full');
      } },
      fetchImpl: async () => jsonResponse(200, { deviceSecret: 'new-secret' }),
      applySecret: apply,
    });
    expect(outcome).toBe('kept-old');
    expect(apply).not.toHaveBeenCalled(); // never swap an unpersisted secret
  });

  it('reports revoked on a 401', async () => {
    const outcome = await rotateDeviceSecret({
      config: deviceConfig,
      store: memoryStore(),
      fetchImpl: async () => jsonResponse(401, {}),
      applySecret: () => {},
    });
    expect(outcome).toBe('revoked');
  });

  it('keeps the old secret on a network error', async () => {
    const outcome = await rotateDeviceSecret({
      config: deviceConfig,
      store: memoryStore(),
      fetchImpl: async () => {
        throw new Error('offline');
      },
      applySecret: () => {},
    });
    expect(outcome).toBe('kept-old');
  });

  it('keeps the old secret on a 500 or a malformed body', async () => {
    const store = memoryStore();
    expect(
      await rotateDeviceSecret({
        config: deviceConfig,
        store,
        fetchImpl: async () => jsonResponse(500, {}),
        applySecret: () => {},
      }),
    ).toBe('kept-old');
    expect(
      await rotateDeviceSecret({
        config: deviceConfig,
        store,
        fetchImpl: async () => jsonResponse(200, { notSecret: 'x' }),
        applySecret: () => {},
      }),
    ).toBe('kept-old');
  });
});
