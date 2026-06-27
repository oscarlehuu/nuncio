import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/*
 * jsdom (vitest 4) does not reliably expose `localStorage` or `matchMedia` as
 * globals. Provide minimal in-memory implementations so theme/component tests
 * are deterministic across environments.
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
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageImpl,
    configurable: true,
    writable: true,
  });
}

if (!globalThis.matchMedia) {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  });
}

if (!globalThis.ResizeObserver) {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  });
}

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: () => {},
  });
}

afterEach(() => {
  cleanup();
});
