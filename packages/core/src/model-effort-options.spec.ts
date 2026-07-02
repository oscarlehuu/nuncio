import { describe, it, expect } from 'vitest';
import {
  effortSliderOptions,
  isEffortSliderOption,
  menuSelectOptions,
  modelSupportsFast,
} from './model-effort-options';
import type { ModelOptionDescriptor } from './model-options';

const CODEX_OPTIONS: ModelOptionDescriptor[] = [
  { id: 'fast', label: 'Fast', type: 'boolean', defaultValue: false },
  {
    id: 'reasoningEffort',
    label: 'Reasoning',
    type: 'select',
    options: [
      { id: 'low', label: 'Low', isDefault: true },
      { id: 'high', label: 'High' },
    ],
    defaultValue: 'low',
  },
  {
    id: 'context',
    label: 'Context',
    type: 'select',
    options: [
      { id: '200k', label: '200k', isDefault: true },
      { id: '1M', label: '1M' },
    ],
    defaultValue: '200k',
  },
];

describe('model-effort-options', () => {
  it('classifies reasoning-style selects as effort sliders', () => {
    expect(isEffortSliderOption('reasoning')).toBe(true);
    expect(isEffortSliderOption('reasoningEffort')).toBe(true);
    expect(isEffortSliderOption('thinkingLevel')).toBe(true);
    expect(isEffortSliderOption('context')).toBe(false);
  });

  it('splits effort sliders from menu selects', () => {
    const model = { options: CODEX_OPTIONS };
    expect(effortSliderOptions(model).map((option) => option.id)).toEqual(['reasoningEffort']);
    expect(menuSelectOptions(model).map((option) => option.id)).toEqual(['context']);
  });

  it('detects fast support from boolean options or fast-only variants', () => {
    expect(modelSupportsFast({ options: CODEX_OPTIONS })).toBe(true);
    expect(
      modelSupportsFast({
        variants: [{ params: [{ id: 'fast', value: 'true' }] }],
      }),
    ).toBe(true);
    expect(modelSupportsFast({ options: [] })).toBe(false);
  });
});
