import { describe, expect, it } from 'vitest';
import {
  authHeader,
  clearConnection,
  loadConnection,
  normalizeServerUrl,
  relayUrlFor,
  saveConnection,
  type KeyValueStore,
} from './connection-store';

function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => {
      map.set(k, v);
    },
    delete: async (k) => {
      map.delete(k);
    },
  };
}

describe('normalizeServerUrl', () => {
  it('defaults to https and strips trailing slashes', () => {
    expect(normalizeServerUrl('mac.tailnet.ts.net')).toBe('https://mac.tailnet.ts.net');
    expect(normalizeServerUrl('https://mac.tailnet.ts.net/')).toBe('https://mac.tailnet.ts.net');
  });

  it('keeps explicit http and ports for LAN use', () => {
    expect(normalizeServerUrl('http://192.168.1.5:3000')).toBe('http://192.168.1.5:3000');
  });

  it('keeps a hub machine base path', () => {
    expect(normalizeServerUrl('https://hub.tailnet.ts.net/m/studio/')).toBe(
      'https://hub.tailnet.ts.net/m/studio',
    );
  });

  it('rejects empty or unparsable input', () => {
    expect(normalizeServerUrl('   ')).toBeNull();
    expect(normalizeServerUrl('http://')).toBeNull();
  });
});

describe('relayUrlFor', () => {
  it('maps http(s) to ws(s) and appends the relay path', () => {
    expect(relayUrlFor('https://mac.ts.net')).toBe('wss://mac.ts.net/api/sessions/ws');
    expect(relayUrlFor('http://192.168.1.5:3000')).toBe('ws://192.168.1.5:3000/api/sessions/ws');
    expect(relayUrlFor('https://hub.ts.net/m/studio')).toBe(
      'wss://hub.ts.net/m/studio/api/sessions/ws',
    );
  });
});

describe('connection persistence', () => {
  it('round-trips a connection through the store', async () => {
    const store = memoryStore();
    await saveConnection(store, { serverUrl: 'https://mac.ts.net', token: 'secret' });
    expect(await loadConnection(store)).toEqual({ serverUrl: 'https://mac.ts.net', token: 'secret' });
    await clearConnection(store);
    expect(await loadConnection(store)).toBeNull();
  });

  it('returns null for corrupt or incomplete payloads', async () => {
    const store = memoryStore();
    await store.set('nuncio.connection', 'not-json');
    expect(await loadConnection(store)).toBeNull();
    await store.set('nuncio.connection', JSON.stringify({ token: 'x' }));
    expect(await loadConnection(store)).toBeNull();
  });

  it('round-trips a v2 device-credential connection', async () => {
    const store = memoryStore();
    const config = {
      serverUrl: 'http://192.168.1.5:3000',
      token: null,
      deviceId: 'dev-1',
      deviceSecret: 'sec-1',
      candidateUrls: ['http://192.168.1.5:3000', 'https://mac.ts.net'],
    };
    await saveConnection(store, config);
    expect(await loadConnection(store)).toEqual(config);
  });

  it('still loads a legacy {serverUrl, token} connection unchanged', async () => {
    // An already-paired phone from before QR pairing has no device fields.
    const store = memoryStore();
    await store.set('nuncio.connection', JSON.stringify({ serverUrl: 'https://mac.ts.net', token: 't' }));
    expect(await loadConnection(store)).toEqual({ serverUrl: 'https://mac.ts.net', token: 't' });
  });

  it('drops a half-written device credential and keeps the legacy token', async () => {
    const store = memoryStore();
    await store.set(
      'nuncio.connection',
      JSON.stringify({ serverUrl: 'https://mac.ts.net', token: 't', deviceId: 'dev-1' }),
    );
    const loaded = await loadConnection(store);
    expect(loaded?.deviceId).toBeUndefined();
    expect(loaded?.deviceSecret).toBeUndefined();
    expect(loaded?.token).toBe('t');
  });

  it('drops candidateUrls that are not a string array', async () => {
    const store = memoryStore();
    await store.set(
      'nuncio.connection',
      JSON.stringify({ serverUrl: 'https://mac.ts.net', token: null, candidateUrls: 'not-array' }),
    );
    expect((await loadConnection(store))?.candidateUrls).toBeUndefined();
  });
});

describe('authHeader', () => {
  it('prefers the device bearer when credentials are present', () => {
    expect(
      authHeader({ serverUrl: 'x', token: 'legacy', deviceId: 'dev-1', deviceSecret: 'sec-1' }),
    ).toEqual({ Authorization: 'Bearer nd1.dev-1.sec-1' });
  });

  it('falls back to the legacy token when there are no device credentials', () => {
    expect(authHeader({ serverUrl: 'x', token: 'legacy' })).toEqual({
      Authorization: 'Bearer legacy',
    });
  });

  it('returns no header when there is neither a device credential nor a token', () => {
    expect(authHeader({ serverUrl: 'x', token: null })).toEqual({});
  });
});
