export type ModelOptionValue = string | boolean;

export type ModelOptionsMap = Record<string, ModelOptionValue>;

export interface ModelOptionChoice {
  id: string;
  label: string;
  isDefault?: boolean;
}

export interface ModelOptionDescriptor {
  id: string;
  label: string;
  type: 'select' | 'boolean';
  options?: ModelOptionChoice[];
  defaultValue?: ModelOptionValue;
}

export function defaultSelectionsFromDescriptors(
  descriptors: readonly ModelOptionDescriptor[] | undefined,
): ModelOptionsMap {
  const out: ModelOptionsMap = {};
  for (const d of descriptors ?? []) {
    if (d.defaultValue !== undefined) {
      out[d.id] = d.defaultValue;
      continue;
    }
    if (d.type === 'boolean') {
      out[d.id] = false;
      continue;
    }
    const fallback = d.options?.find((o) => o.isDefault) ?? d.options?.[0];
    if (fallback) out[d.id] = fallback.id;
  }
  return out;
}

export function mergeModelOptions(
  descriptors: readonly ModelOptionDescriptor[] | undefined,
  current: ModelOptionsMap | undefined,
): ModelOptionsMap {
  return { ...defaultSelectionsFromDescriptors(descriptors), ...(current ?? {}) };
}

export function optionSummaryLabel(
  descriptors: readonly ModelOptionDescriptor[] | undefined,
  selections: ModelOptionsMap,
): string | null {
  if (!descriptors?.length) return null;
  const parts: string[] = [];
  for (const d of descriptors) {
    const value = selections[d.id];
    if (value === undefined) continue;
    if (d.type === 'boolean') {
      if (value === true) parts.push(d.label);
      continue;
    }
    const label = d.options?.find((o) => o.id === value)?.label ?? String(value);
    parts.push(`${d.label}: ${label}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
