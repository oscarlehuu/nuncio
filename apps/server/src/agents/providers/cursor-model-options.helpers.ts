import type {
  ModelOptionChoiceDto,
  ModelOptionDescriptorDto,
  ModelOptionsMap,
} from '../../models/model-options.types';
import { defaultSelectionsFromDescriptors } from '../../models/model-options.types';

export type CursorModelParameter = {
  id: string;
  displayName?: string;
  values: Array<{ value: string; displayName?: string }>;
};

export type CursorModelListItem = {
  id: string;
  displayName?: string;
  parameters?: CursorModelParameter[];
  variants?: Array<{
    params: Array<{ id: string; value: string }>;
    displayName: string;
    isDefault?: boolean;
  }>;
};

export type CursorModelParam = { id: string; value: string };

function isBooleanParameter(param: CursorModelParameter): boolean {
  if (param.values.length !== 2) return false;
  const values = new Set(param.values.map((v) => v.value.toLowerCase()));
  return values.has('true') && values.has('false');
}

function labelForValue(param: CursorModelParameter, value: string): string {
  return param.values.find((v) => v.value === value)?.displayName ?? value;
}

export function cursorParametersToDescriptors(
  parameters: CursorModelParameter[] | undefined,
): ModelOptionDescriptorDto[] {
  if (!parameters?.length) return [];
  return parameters.map((param) => {
    if (isBooleanParameter(param)) {
      const defaultEntry =
        param.values.find((v) => v.value.toLowerCase() === 'false') ?? param.values[0];
      return {
        id: param.id,
        label: param.displayName ?? param.id,
        type: 'boolean' as const,
        defaultValue: defaultEntry?.value.toLowerCase() === 'true',
      };
    }
    const options: ModelOptionChoiceDto[] = param.values.map((v, idx) => ({
      id: v.value,
      label: v.displayName ?? v.value,
      ...(idx === 0 ? { isDefault: true as const } : {}),
    }));
    return {
      id: param.id,
      label: param.displayName ?? param.id,
      type: 'select' as const,
      options,
      defaultValue: options[0]?.id,
    };
  });
}

function allowedValues(param: CursorModelParameter): Set<string> {
  return new Set(param.values.map((v) => v.value));
}

export function buildCursorModelParams(
  selections: ModelOptionsMap | null | undefined,
  parameters: CursorModelParameter[] | undefined,
): CursorModelParam[] | undefined {
  if (!parameters?.length) return undefined;
  const defaults = cursorParametersToDescriptors(parameters);
  const merged: ModelOptionsMap = {
    ...defaultSelectionsFromDescriptors(defaults),
    ...(selections ?? {}),
  };

  const params: CursorModelParam[] = [];
  for (const param of parameters) {
    const raw = merged[param.id];
    if (raw === undefined) continue;
    if (typeof raw === 'boolean') {
      params.push({ id: param.id, value: raw ? 'true' : 'false' });
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed || !allowedValues(param).has(trimmed)) continue;
    params.push({ id: param.id, value: trimmed });
  }
  return params.length > 0 ? params : undefined;
}

export function cursorModelItemLabel(item: CursorModelListItem): string {
  return item.displayName?.trim() || item.id;
}
