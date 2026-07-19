// Distilled from real Nuncio session 1e9997f2 (2026-07-13): changing the model
// in one Workbench/Home composer flipped every other picker's selection because
// preference was a single global localStorage key. The shipped fix added
// per-composer scoped keys (fbb4afa8). This fixture plants the pre-fix global
// store + the post-fix unit contract so a Builder must implement scoping to
// make `bun test` green — without cloning the whole monorepo.
import { buildFixture } from '../lib/deterministic-git.mjs';

const FILES = {
  'package.json': `${JSON.stringify(
    {
      name: 'model-pref-composer-scope',
      version: '0.0.0',
      private: true,
      scripts: { test: 'bun test' },
    },
    null,
    2,
  )}\n`,
  'README.md': `# model-pref-composer-scope

Distilled from Nuncio session \`1e9997f2\`: isolate model picker preference per
composer (Home vs each Workbench slot) while keeping a legacy global default.
`,
  'src/model-preference.ts': `export const MODEL_PREFERENCE_STORAGE_KEY = 'nuncio-model-preference';

export type ModelPreference = {
  modelId: string;
  providerId: string;
};

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function loadModelPreference(storage: StorageLike): ModelPreference | null {
  try {
    const raw = storage.getItem(MODEL_PREFERENCE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ModelPreference;
    if (!parsed?.modelId || !parsed?.providerId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveModelPreference(pref: ModelPreference, storage: StorageLike): void {
  storage.setItem(MODEL_PREFERENCE_STORAGE_KEY, JSON.stringify(pref));
}

// Scoped APIs are intentionally missing — the failing tests require them.
`,
  'test/model-preference.spec.ts': `import { expect, test, beforeEach } from 'bun:test';
import {
  loadModelPreference,
  loadScopedModelPreference,
  MODEL_PREFERENCE_STORAGE_KEY,
  saveModelPreference,
  saveScopedModelPreference,
  scopedModelPreferenceStorageKey,
} from '../src/model-preference';

class MemoryStorage {
  #map = new Map<string, string>();
  getItem(key: string) {
    return this.#map.has(key) ? this.#map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.#map.set(key, value);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
});

test('round-trips the legacy global preference', () => {
  saveModelPreference({ modelId: 'anthropic:claude-haiku-4', providerId: 'pi' }, storage);
  expect(loadModelPreference(storage)).toEqual({
    modelId: 'anthropic:claude-haiku-4',
    providerId: 'pi',
  });
});

test('isolates scoped selections while preserving the legacy global default', () => {
  saveModelPreference({ modelId: 'anthropic:claude-haiku-4', providerId: 'pi' }, storage);

  expect(loadScopedModelPreference('home:new-agent', storage)).toEqual({
    modelId: 'anthropic:claude-haiku-4',
    providerId: 'pi',
  });

  saveScopedModelPreference(
    'home:new-agent',
    { modelId: 'cursor:composer-2.5', providerId: 'cursor' },
    storage,
  );
  saveScopedModelPreference(
    'workbench-slot:0',
    { modelId: 'codex:gpt-5.6-sol', providerId: 'codex' },
    storage,
  );

  expect(loadScopedModelPreference('home:new-agent', storage)?.modelId).toBe('cursor:composer-2.5');
  expect(loadScopedModelPreference('workbench-slot:0', storage)?.modelId).toBe('codex:gpt-5.6-sol');
  expect(loadScopedModelPreference('workbench-slot:1', storage)?.modelId).toBe(
    'anthropic:claude-haiku-4',
  );
  expect(loadModelPreference(storage)?.modelId).toBe('anthropic:claude-haiku-4');
  expect(storage.getItem(scopedModelPreferenceStorageKey('workbench-slot:0'))).not.toBeNull();
  expect(storage.getItem(MODEL_PREFERENCE_STORAGE_KEY)).not.toBeNull();
});

test('falls back to the legacy global value when scoped JSON is corrupt', () => {
  saveModelPreference({ modelId: 'anthropic:claude-haiku-4', providerId: 'pi' }, storage);
  storage.setItem(scopedModelPreferenceStorageKey('home:new-agent'), '{not-json');
  expect(loadScopedModelPreference('home:new-agent', storage)?.modelId).toBe(
    'anthropic:claude-haiku-4',
  );
});
`,
};

export async function setup(dir) {
  await buildFixture(dir, FILES);
  return dir;
}
