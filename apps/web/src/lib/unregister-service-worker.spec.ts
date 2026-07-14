// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('unregisterLegacyServiceWorker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function loadUnregister() {
    return import('./unregister-service-worker');
  }

  it('no-ops when serviceWorker is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const { unregisterLegacyServiceWorker } = await loadUnregister();
    expect(() => unregisterLegacyServiceWorker()).not.toThrow();
  });

  it('unregisters all service workers and deletes matching caches', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    const getRegistrations = vi.fn().mockResolvedValue([{ unregister }, { unregister }]);
    const deleteCache = vi.fn().mockResolvedValue(true);
    const keys = vi.fn().mockResolvedValue([
      'workbox-precache-v2',
      'other-app-cache',
      'nuncio-shell-v1',
    ]);
    const cacheApi = { keys, delete: deleteCache };

    vi.stubGlobal('navigator', { serviceWorker: { getRegistrations } });
    vi.stubGlobal('caches', cacheApi);
    Object.defineProperty(window, 'caches', { value: cacheApi, configurable: true });

    const { unregisterLegacyServiceWorker } = await loadUnregister();
    unregisterLegacyServiceWorker();

    await vi.waitFor(() => expect(getRegistrations).toHaveBeenCalled());
    await vi.waitFor(() => expect(deleteCache).toHaveBeenCalledTimes(2));

    expect(unregister).toHaveBeenCalledTimes(2);
    expect(deleteCache).toHaveBeenCalledWith('workbox-precache-v2');
    expect(deleteCache).toHaveBeenCalledWith('nuncio-shell-v1');
    expect(deleteCache).not.toHaveBeenCalledWith('other-app-cache');
  });

  it('swallows cleanup failures without throwing', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: vi.fn().mockRejectedValue(new Error('SecurityError')),
      },
    });
    vi.stubGlobal('caches', { keys: vi.fn(), delete: vi.fn() });
    Object.defineProperty(window, 'caches', {
      value: { keys: vi.fn(), delete: vi.fn() },
      configurable: true,
    });

    const { unregisterLegacyServiceWorker } = await loadUnregister();
    expect(() => unregisterLegacyServiceWorker()).not.toThrow();
    await vi.waitFor(() =>
      expect(navigator.serviceWorker.getRegistrations).toHaveBeenCalled(),
    );
  });

  it('skips cache deletion when caches is unavailable on window', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    const deleteCache = vi.fn();
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: vi.fn().mockResolvedValue([{ unregister }]),
      },
    });
    vi.stubGlobal('caches', { keys: vi.fn(), delete: deleteCache });
    Reflect.deleteProperty(window, 'caches');

    const { unregisterLegacyServiceWorker } = await loadUnregister();
    unregisterLegacyServiceWorker();
    await vi.waitFor(() => expect(unregister).toHaveBeenCalled());
    expect(deleteCache).not.toHaveBeenCalled();
  });
});
