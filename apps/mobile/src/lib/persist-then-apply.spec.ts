import { describe, expect, it, vi } from 'vitest';
import { persistThenApply } from './persist-then-apply';
import type { ConnectionConfig, KeyValueStore } from './connection-store';

const config: ConnectionConfig = {
  serverUrl: 'http://a',
  token: null,
  deviceId: 'dev-1',
  deviceSecret: 'sec-1',
};

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

describe('persistThenApply', () => {
  it('persists first, then applies, in that order', async () => {
    const store = memoryStore();
    const events: string[] = [];
    const outcome = await persistThenApply(
      { ...store, set: async (k, v) => {
        events.push('persist');
        await store.set(k, v);
      } },
      config,
      () => events.push('apply'),
    );
    expect(outcome).toBe('saved');
    expect(events).toEqual(['persist', 'apply']); // the single-use secret is committed before use
    expect(JSON.parse(store.data.get('nuncio.connection')!).deviceSecret).toBe('sec-1');
  });

  it('does NOT apply when the store write fails', async () => {
    const apply = vi.fn();
    const outcome = await persistThenApply(
      { ...memoryStore(), set: async () => {
        throw new Error('keychain unavailable');
      } },
      config,
      apply,
    );
    expect(outcome).toBe('save-failed');
    expect(apply).not.toHaveBeenCalled(); // never swap an unpersisted single-use secret
  });
});
