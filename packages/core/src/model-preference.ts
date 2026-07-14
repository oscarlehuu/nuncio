import { defaultOptionsForModel, mergeOptionsForModel } from './model-picker-catalog';
import type { ModelOptionsMap } from './model-options';
import {
  modelById,
  normalizeModelCatalog,
  pickDefaultModelSelection,
  type ModelProvider,
} from './model-providers';

export const MODEL_PREFERENCE_STORAGE_KEY = 'nuncio-model-preference';
const MODEL_PREFERENCE_SCOPE_SEPARATOR = ':';

export type ModelPreference = {
  modelId: string;
  providerId: string;
  modelOptions?: ModelOptionsMap;
};

function readModelPreference(key: string, storage: Storage): ModelPreference | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ModelPreference;
    if (!parsed?.modelId || !parsed?.providerId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadModelPreference(storage: Storage = localStorage): ModelPreference | null {
  return readModelPreference(MODEL_PREFERENCE_STORAGE_KEY, storage);
}

export function saveModelPreference(
  pref: ModelPreference,
  storage: Storage = localStorage,
): void {
  storage.setItem(MODEL_PREFERENCE_STORAGE_KEY, JSON.stringify(pref));
}

/** Stable storage key for one model-selection owner (for example Home or a Workbench slot). */
export function scopedModelPreferenceStorageKey(scope: string): string {
  return `${MODEL_PREFERENCE_STORAGE_KEY}${MODEL_PREFERENCE_SCOPE_SEPARATOR}${encodeURIComponent(scope)}`;
}

/**
 * Load a selection owned by one composer. A legacy global preference is only a
 * compatibility/default seed; once this scope is saved, other scopes cannot
 * overwrite it.
 */
export function loadScopedModelPreference(
  scope: string,
  storage: Storage = localStorage,
): ModelPreference | null {
  const scoped = readModelPreference(scopedModelPreferenceStorageKey(scope), storage);
  if (scoped) return scoped;

  const legacy = loadModelPreference(storage);
  if (!legacy) return null;
  try {
    saveScopedModelPreference(scope, legacy, storage);
  } catch {
    // Storage can be unavailable; the legacy value is still a valid in-memory seed.
  }
  return legacy;
}

export function saveScopedModelPreference(
  scope: string,
  pref: ModelPreference,
  storage: Storage = localStorage,
): void {
  storage.setItem(scopedModelPreferenceStorageKey(scope), JSON.stringify(pref));
}

/** Restore last picker choice, or fall back to catalog default. */
export function resolveModelSelection(
  providers: ModelProvider[],
  stored: ModelPreference | null,
): { modelId: string; providerId: string; modelOptions: ModelOptionsMap } | null {
  const catalog = normalizeModelCatalog(providers.filter((p) => !p.unavailable));
  const lookup = modelById(catalog);

  if (stored) {
    const model = lookup[stored.modelId];
    if (model && model.providerId === stored.providerId) {
      return {
        modelId: stored.modelId,
        providerId: stored.providerId,
        modelOptions: mergeOptionsForModel(model, stored.modelOptions),
      };
    }
  }

  const picked = pickDefaultModelSelection(providers);
  if (!picked) return null;
  const model = lookup[picked.modelId];
  return {
    modelId: picked.modelId,
    providerId: picked.providerId,
    modelOptions: defaultOptionsForModel(model),
  };
}

export const MODEL_RECENTS_STORAGE_KEY = 'nuncio-model-recents';

/** How many recently used models the picker surfaces. */
export const MODEL_RECENTS_LIMIT = 3;

export type RecentModel = {
  modelId: string;
  providerId: string;
};

/** Most-recent-first list of models the user actually selected. Fails soft to []. */
export function loadRecentModels(storage: Storage = localStorage): RecentModel[] {
  try {
    const raw = storage.getItem(MODEL_RECENTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is RecentModel =>
          !!entry &&
          typeof entry === 'object' &&
          typeof (entry as RecentModel).modelId === 'string' &&
          typeof (entry as RecentModel).providerId === 'string',
      )
      .slice(0, MODEL_RECENTS_LIMIT);
  } catch {
    return [];
  }
}

/** Push a selection to the front, deduped by modelId and capped at the limit. */
export function recordRecentModel(
  entry: RecentModel,
  storage: Storage = localStorage,
): RecentModel[] {
  const next = [
    { modelId: entry.modelId, providerId: entry.providerId },
    ...loadRecentModels(storage).filter((recent) => recent.modelId !== entry.modelId),
  ].slice(0, MODEL_RECENTS_LIMIT);
  try {
    storage.setItem(MODEL_RECENTS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage full or unavailable — recents are a convenience, not state */
  }
  return next;
}
