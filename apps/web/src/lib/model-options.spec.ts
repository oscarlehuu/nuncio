import { describe, it, expect } from 'vitest';
import {
  defaultSelectionsFromDescriptors,
  optionSummaryLabel,
  type ModelOptionDescriptor,
} from './model-options';

const FAST_BOOLEAN: ModelOptionDescriptor = {
  id: 'fast',
  label: 'Fast Mode',
  type: 'boolean',
  defaultValue: false,
};

const REASONING_SELECT: ModelOptionDescriptor = {
  id: 'reasoning',
  label: 'Reasoning',
  type: 'select',
  options: [
    { id: 'low', label: 'Low', isDefault: true },
    { id: 'high', label: 'High' },
  ],
  defaultValue: 'low',
};

describe('defaultSelectionsFromDescriptors', () => {
  it('builds defaults for boolean and select descriptors', () => {
    expect(defaultSelectionsFromDescriptors([FAST_BOOLEAN, REASONING_SELECT])).toEqual({
      fast: false,
      reasoning: 'low',
    });
  });
});

describe('optionSummaryLabel', () => {
  it('summarizes active boolean and select options', () => {
    expect(
      optionSummaryLabel([FAST_BOOLEAN, REASONING_SELECT], {
        fast: true,
        reasoning: 'high',
      }),
    ).toBe('Fast Mode · Reasoning: High');
  });
});
