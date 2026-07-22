import { describe, expect, it, vi } from 'vitest';
import { connectManualCandidate } from './manual-pairing-controller';
import {
  loadConnection,
  saveConnection,
  type ConnectionConfig,
  type KeyValueStore,
} from './connection-store';

const previous: ConnectionConfig = {
  serverUrl: 'https://good.tailnet.ts.net',
  token: 'good-token',
};
const candidate: ConnectionConfig = {
  serverUrl: 'https://candidate.tailnet.ts.net',
  token: 'candidate-token',
};

function response(status: number, body?: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
  };
}

describe('connectManualCandidate', () => {
  it('validates candidate auth without replacing an existing live or persisted connection', async () => {
    const store = memoryStore();
    await saveConnection(store, previous);
    const apply = vi.fn();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: 'Bearer candidate-token' });
      return response(200, { authenticated: false });
    });

    const result = await connectManualCandidate(candidate, { store, apply, fetchImpl });

    expect(result).toEqual({ kind: 'unauthorized' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://candidate.tailnet.ts.net/api/auth/status',
      expect.any(Object),
    );
    expect(apply).not.toHaveBeenCalled();
    expect(await loadConnection(store)).toEqual(previous);
  });

  it('preserves the existing connection when candidate validation cannot reach the network', async () => {
    const store = memoryStore();
    await saveConnection(store, previous);
    const apply = vi.fn();

    const result = await connectManualCandidate(candidate, {
      store,
      apply,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });

    expect(result).toEqual({ kind: 'network-error' });
    expect(apply).not.toHaveBeenCalled();
    expect(await loadConnection(store)).toEqual(previous);
  });

  it('restores the previous persisted connection when a candidate write mutates then throws', async () => {
    const base = memoryStore();
    await saveConnection(base, previous);
    let failCandidateWrite = true;
    const store: KeyValueStore = {
      ...base,
      set: async (key, value) => {
        base.data.set(key, value);
        const parsed = JSON.parse(value) as ConnectionConfig;
        if (failCandidateWrite && parsed.serverUrl === candidate.serverUrl) {
          failCandidateWrite = false;
          throw new Error('keychain write failed after mutation');
        }
      },
    };
    const apply = vi.fn();

    const result = await connectManualCandidate(candidate, {
      store,
      apply,
      fetchImpl: async () => response(200, { authenticated: true }),
    });

    expect(result).toEqual({ kind: 'persist-error' });
    expect(apply).not.toHaveBeenCalled();
    expect(await loadConnection(base)).toEqual(previous);
  });

  it('persists before applying after authenticated validation succeeds', async () => {
    const store = memoryStore();
    await saveConnection(store, previous);
    const events: string[] = [];
    const trackedStore: KeyValueStore = {
      ...store,
      set: async (key, value) => {
        events.push('persist');
        store.data.set(key, value);
      },
    };

    const result = await connectManualCandidate(candidate, {
      store: trackedStore,
      fetchImpl: async () => {
        events.push('validate');
        return response(200, { authenticated: true });
      },
      apply: () => events.push('apply'),
    });

    expect(result).toEqual({ kind: 'connected' });
    expect(events).toEqual(['validate', 'persist', 'apply']);
    expect(await loadConnection(store)).toEqual(candidate);
  });
});
