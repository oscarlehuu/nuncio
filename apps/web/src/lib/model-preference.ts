import { defaultOptionsForModel, mergeOptionsForModel } from './model-picker-catalog';
import type { ModelOptionsMap } from './model-options';
import {
  modelById,
  normalizeModelCatalog,
  pickDefaultModelSelection,
  type ModelProvider,
} from './model-providers';

export const MODEL_PREFERENCE_STORAGE_KEY = 'nuncio-model-preference';

export type ModelPreference = {
  modelId: string;
  providerId: string;
  modelOptions?: ModelOptionsMap;
};

export function loadModelPreference(storage: Storage = localStorage): ModelPreference | null {
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

export function saveModelPreference(
  pref: ModelPreference,
  storage: Storage = localStorage,
): void {
  storage.setItem(MODEL_PREFERENCE_STORAGE_KEY, JSON.stringify(pref));
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
