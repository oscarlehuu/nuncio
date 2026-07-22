import { describe, expect, it } from 'vitest';
import type { ModelOptionDescriptor } from '@nuncio/core/model-options';
import { composerModelOptionDescriptors } from './model-option-descriptors';

const reasoning: ModelOptionDescriptor = {
  id: 'reasoningEffort',
  label: 'Reasoning',
  type: 'select',
  defaultValue: 'medium',
  options: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium', isDefault: true },
  ],
};

const priority: ModelOptionDescriptor = {
  id: 'fast',
  label: 'Priority',
  type: 'boolean',
  defaultValue: false,
};

describe('composerModelOptionDescriptors', () => {
  it('returns an empty list when no model is selected', () => {
    expect(composerModelOptionDescriptors(undefined)).toEqual([]);
    expect(composerModelOptionDescriptors(null)).toEqual([]);
  });

  it('passes through catalog options unchanged when fast is already declared', () => {
    const options = [reasoning, priority];
    expect(
      composerModelOptionDescriptors({
        options,
        variants: [{ params: [{ id: 'fast', value: 'true' }] }],
      }),
    ).toEqual(options);
  });

  it('synthesizes a Priority toggle when fast exists only as a fast-only variant', () => {
    // Regression for #146 — without this, the Options sheet hid Priority for
    // Codex/Cursor models that only advertise fast via variants.
    expect(
      composerModelOptionDescriptors({
        options: [reasoning],
        variants: [{ params: [{ id: 'fast', value: 'true' }] }],
      }),
    ).toEqual([reasoning, priority]);
  });

  it('synthesizes Priority for a bare fast-only variant model with no options', () => {
    expect(
      composerModelOptionDescriptors({
        variants: [{ params: [{ id: 'fast', value: 'TRUE' }] }],
      }),
    ).toEqual([priority]);
  });

  it('does not invent Priority when variants are mixed or absent', () => {
    expect(
      composerModelOptionDescriptors({
        options: [reasoning],
        variants: [
          { params: [{ id: 'fast', value: 'true' }] },
          { params: [{ id: 'reasoningEffort', value: 'high' }] },
        ],
      }),
    ).toEqual([reasoning]);

    expect(composerModelOptionDescriptors({ options: [reasoning] })).toEqual([reasoning]);
  });
});
