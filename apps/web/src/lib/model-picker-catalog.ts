import {
  defaultSelectionsFromDescriptors,
  mergeModelOptions,
  type ModelOptionDescriptor,
  type ModelOptionsMap,
} from './model-options';
import type { FlatModel } from './model-providers';
import { prettyModelName } from './model-providers';
import { isTriggerIconOption, modelSupportsFast } from './model-effort-options';

export type ModelVariant = {
  label: string;
  params: Array<{ id: string; value: string }>;
  isDefault?: boolean;
};

export function variantParamsToOptions(
  params: Array<{ id: string; value: string }> | undefined,
): ModelOptionsMap {
  const out: ModelOptionsMap = {};
  for (const param of params ?? []) {
    const lower = param.value.toLowerCase();
    if (lower === 'true' || lower === 'false') {
      out[param.id] = lower === 'true';
      continue;
    }
    out[param.id] = param.value;
  }
  return out;
}

export function normalizeModelOptions(options: ModelOptionsMap | undefined): ModelOptionsMap {
  const out: ModelOptionsMap = {};
  for (const [key, value] of Object.entries(options ?? {})) {
    if (typeof value === 'string' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export function modelOptionsEqual(
  a: ModelOptionsMap | undefined,
  b: ModelOptionsMap | undefined,
): boolean {
  const left = normalizeModelOptions(a);
  const right = normalizeModelOptions(b);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

export function isActiveModelSelection(
  modelId: string,
  modelOptions: ModelOptionsMap | undefined,
  candidateModelId: string,
  candidateOptions: ModelOptionsMap | undefined,
): boolean {
  return modelId === candidateModelId && modelOptionsEqual(modelOptions, candidateOptions);
}

export function defaultOptionsForModel(model: FlatModel | undefined): ModelOptionsMap {
  return defaultSelectionsFromDescriptors(model?.options);
}

export function findMatchingVariant(
  model: FlatModel | undefined,
  modelOptions: ModelOptionsMap | undefined,
): ModelVariant | undefined {
  if (!model?.variants?.length) return undefined;
  return model.variants.find((variant) =>
    modelOptionsEqual(modelOptions, variantParamsToOptions(variant.params)),
  );
}

function isFastOnlyVariant(variant: ModelVariant): boolean {
  return (
    variant.params.length === 1 &&
    variant.params[0]?.id === 'fast' &&
    variant.params[0]?.value.toLowerCase() === 'true'
  );
}

export type ModelOptionBadge = { id: string; label: string };

/** Option labels beside the model name (Cursor-style). Booleans only when on; selects always. */
export function activeModelOptionBadges(
  model: FlatModel | undefined,
  modelOptions: ModelOptionsMap | undefined,
): ModelOptionBadge[] {
  if (!model) return [];
  const selections = mergeOptionsForModel(model, modelOptions);
  const badges: ModelOptionBadge[] = [];

  for (const descriptor of booleanOptionsForModel(model)) {
    if (descriptor.id === 'fast') continue;
    if (selections[descriptor.id] === true) {
      badges.push({ id: descriptor.id, label: descriptor.label });
    }
  }

  for (const descriptor of selectOptionsForModel(model)) {
    if (isTriggerIconOption(descriptor.id)) continue;
    const value = selections[descriptor.id];
    if (value === undefined || typeof value === 'boolean') continue;
    const label =
      descriptor.options?.find((choice) => choice.id === value)?.label ?? String(value);
    badges.push({ id: descriptor.id, label });
  }

  return badges;
}

export function formatModelPickerLabel(
  model: FlatModel | undefined,
  modelOptions: ModelOptionsMap | undefined,
): string {
  if (!model) return 'Select model';
  const selections = mergeOptionsForModel(model, modelOptions);
  const badges = activeModelOptionBadges(model, modelOptions);
  const name = prettyModelName(model.name);
  const suffix: string[] = [];
  if (modelSupportsFast(model) && selections.fast === true) suffix.push('Fast');
  suffix.push(...badges.map((badge) => badge.label));
  if (suffix.length === 0) return name;
  return `${name} ${suffix.join(' ')}`;
}

export function modelShowsSubmenu(model: FlatModel): boolean {
  if (modelShowsVariantRows(model)) return false;
  if (selectOptionsForModel(model).length > 0) return true;
  return modelIsBooleanOnly(model);
}

export function modelShowsVariantRows(model: FlatModel): boolean {
  // When parameters are mapped to options, use the Options submenu — not per-combo rows.
  if ((model.options?.length ?? 0) > 0) return false;
  const variants = model.variants ?? [];
  if (variants.length === 0) return false;
  if (variants.every(isFastOnlyVariant)) return false;
  return true;
}

/** Options payload for a plain model row (boolean-only models use descriptor defaults). */
export function plainRowOptions(model: FlatModel): ModelOptionsMap {
  const booleans = booleanOptionsForModel(model);
  const selects = selectOptionsForModel(model);
  if (booleans.length > 0 && selects.length === 0) {
    return defaultSelectionsFromDescriptors(booleans);
  }
  return {};
}

export function selectOptionsForModel(model: FlatModel): ModelOptionDescriptor[] {
  return (model.options ?? []).filter((option) => option.type === 'select');
}

export function effectiveOptionDescriptors(model: FlatModel): ModelOptionDescriptor[] {
  const booleans = booleanOptionsForModel(model);
  const selects = selectOptionsForModel(model);
  if (booleans.length > 0 || selects.length > 0) return [...booleans, ...selects];
  return model.options ?? [];
}

export function mergeOptionsForModel(
  model: FlatModel,
  partial: ModelOptionsMap | undefined,
): ModelOptionsMap {
  const descriptors = effectiveOptionDescriptors(model);
  const merged = mergeModelOptions(descriptors, partial);
  const allowed = new Set(descriptors.map((descriptor) => descriptor.id));
  const out: ModelOptionsMap = {};
  for (const [key, value] of Object.entries(merged)) {
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}

export function modelHasBooleanOptions(model: FlatModel): boolean {
  return booleanOptionsForModel(model).length > 0;
}

export function modelIsBooleanOnly(model: FlatModel): boolean {
  return (
    modelHasBooleanOptions(model) &&
    selectOptionsForModel(model).length === 0 &&
    !modelShowsVariantRows(model)
  );
}

export function booleanOptionsForModel(model: FlatModel): ModelOptionDescriptor[] {
  const fromCatalog = (model.options ?? []).filter((option) => option.type === 'boolean');
  if (fromCatalog.length > 0) return fromCatalog;
  const variants = model.variants ?? [];
  if (variants.length > 0 && variants.every(isFastOnlyVariant)) {
    return [{ id: 'fast', label: 'Fast', type: 'boolean', defaultValue: false }];
  }
  return [];
}
