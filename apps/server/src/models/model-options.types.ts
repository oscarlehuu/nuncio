/** Per-session model option values (e.g. fast=true, thinkingLevel=high). */
export type ModelOptionValue = string | boolean;

export type ModelOptionsMap = Record<string, ModelOptionValue>;

export interface ModelOptionChoiceDto {
  id: string;
  label: string;
  isDefault?: boolean;
}

export interface ModelOptionDescriptorDto {
  id: string;
  label: string;
  type: 'select' | 'boolean';
  options?: ModelOptionChoiceDto[];
  defaultValue?: ModelOptionValue;
}

export function parseModelOptionsJson(raw: string | null | undefined): ModelOptionsMap | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: ModelOptionsMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' || typeof value === 'boolean') out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function stringifyModelOptions(options: ModelOptionsMap | null | undefined): string | null {
  if (!options || Object.keys(options).length === 0) return null;
  return JSON.stringify(options);
}

export function defaultSelectionsFromDescriptors(
  descriptors: readonly ModelOptionDescriptorDto[] | undefined,
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
