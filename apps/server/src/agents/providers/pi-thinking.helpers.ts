import type { ModelOptionDescriptorDto, ModelOptionsMap } from '../../models/model-options.types';

export const PI_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

const PI_THINKING_LABELS: Record<PiThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
};

const PI_DEFAULT_SUPPORTED = new Set<PiThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export type PiModelThinkingMeta = {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>>;
};

export function isPiThinkingLevel(value: string | null | undefined): value is PiThinkingLevel {
  return (
    value === 'off' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  );
}

function supportedLevelsForModel(model: PiModelThinkingMeta | undefined): PiThinkingLevel[] {
  if (!model?.reasoning) return [];
  const map = model.thinkingLevelMap;
  if (map && Object.keys(map).length > 0) {
    return PI_THINKING_LEVELS.filter((level) => {
      const mapped = map[level];
      if (mapped === null) return false;
      return mapped !== undefined || PI_DEFAULT_SUPPORTED.has(level);
    });
  }
  return [...PI_THINKING_LEVELS];
}

export function piThinkingDescriptors(
  model: PiModelThinkingMeta | undefined,
): ModelOptionDescriptorDto[] {
  const levels = supportedLevelsForModel(model);
  if (levels.length === 0) return [];
  const defaultLevel: PiThinkingLevel = levels.includes('medium') ? 'medium' : levels[0]!;
  return [
    {
      id: 'thinkingLevel',
      label: 'Thinking',
      type: 'select',
      options: levels.map((level) => ({
        id: level,
        label: PI_THINKING_LABELS[level],
        ...(level === defaultLevel ? { isDefault: true as const } : {}),
      })),
      defaultValue: defaultLevel,
    },
  ];
}

export function resolvePiThinkingLevel(
  selections: ModelOptionsMap | null | undefined,
  model: PiModelThinkingMeta | undefined,
): PiThinkingLevel | undefined {
  const levels = new Set(supportedLevelsForModel(model));
  if (levels.size === 0) return undefined;
  const raw = selections?.thinkingLevel;
  if (typeof raw === 'string' && isPiThinkingLevel(raw) && levels.has(raw)) return raw;
  const descriptors = piThinkingDescriptors(model);
  const fallback = descriptors[0]?.defaultValue;
  return typeof fallback === 'string' && isPiThinkingLevel(fallback) ? fallback : undefined;
}
