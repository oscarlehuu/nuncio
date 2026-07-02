/*
 * This package runs in a plain node environment; provide the in-memory
 * localStorage that model-preference tests rely on (same shape as the web
 * app's test setup) so specs behave identically in both packages.
 */
if (!globalThis.localStorage) {
  const store = new Map<string, string>();
  const localStorageImpl: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: localStorageImpl });
}
