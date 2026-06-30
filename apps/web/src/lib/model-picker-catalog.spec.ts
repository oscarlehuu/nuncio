import { describe, it, expect } from 'vitest';
import {
  activeModelOptionBadges,
  formatModelPickerLabel,
  isActiveModelSelection,
  mergeOptionsForModel,
  modelOptionsEqual,
  modelIsBooleanOnly,
  modelShowsSubmenu,
  modelShowsVariantRows,
  plainRowOptions,
  variantParamsToOptions,
} from './model-picker-catalog';
import type { FlatModel } from './model-providers';

const OPUS_MODEL: FlatModel = {
  id: 'anthropic:claude-opus-4-6',
  name: 'Claude Opus 4.6',
  providerId: 'pi',
  providerName: 'Pi',
  groupId: 'anthropic',
  groupName: 'Anthropic',
  options: [
    {
      id: 'thinkingLevel',
      label: 'Thinking',
      type: 'select',
      options: [
        { id: 'medium', label: 'Medium', isDefault: true },
        { id: 'high', label: 'High' },
      ],
      defaultValue: 'medium',
    },
  ],
};

const COMPOSER_MODEL: FlatModel = {
  id: 'cursor:composer-2.5',
  name: 'Composer 2.5',
  providerId: 'cursor',
  providerName: 'Cursor',
  groupId: 'cursor',
  groupName: 'Cursor',
  options: [{ id: 'fast', label: 'Fast', type: 'boolean', defaultValue: false }],
  variants: [{ label: 'Composer 2.5 Fast', params: [{ id: 'fast', value: 'true' }] }],
};

const CODEX_MODEL: FlatModel = {
  id: 'codex:gpt-5.5',
  name: 'GPT-5.5',
  providerId: 'codex',
  providerName: 'Codex',
  groupId: 'openai',
  groupName: 'OpenAI',
  options: [
    { id: 'fast', label: 'Priority', type: 'boolean', defaultValue: false },
    {
      id: 'reasoningEffort',
      label: 'Reasoning',
      type: 'select',
      options: [
        { id: 'medium', label: 'Medium', isDefault: true },
        { id: 'xhigh', label: 'Xhigh' },
      ],
      defaultValue: 'medium',
    },
  ],
};

describe('variantParamsToOptions', () => {
  it('maps cursor variant params to modelOptions', () => {
    expect(
      variantParamsToOptions([
        { id: 'fast', value: 'true' },
        { id: 'reasoning', value: 'max' },
      ]),
    ).toEqual({ fast: true, reasoning: 'max' });
  });
});

describe('isActiveModelSelection', () => {
  it('matches model id and options together', () => {
    expect(
      isActiveModelSelection(
        'cursor:composer-2.5',
        { reasoning: 'high' },
        'cursor:composer-2.5',
        { reasoning: 'high' },
      ),
    ).toBe(true);
    expect(
      isActiveModelSelection(
        'cursor:composer-2.5',
        { reasoning: 'high' },
        'cursor:composer-2.5',
        { reasoning: 'low' },
      ),
    ).toBe(false);
  });
});

describe('modelShowsVariantRows', () => {
  it('hides fast-only variants so composer is a plain row', () => {
    expect(modelShowsVariantRows(COMPOSER_MODEL)).toBe(false);
  });

  it('shows non-fast-only variant rows only when no options exist', () => {
    const model: FlatModel = {
      ...COMPOSER_MODEL,
      options: undefined,
      variants: [{ label: 'opus (xhigh)', params: [{ id: 'reasoning', value: 'xhigh' }] }],
    };
    expect(modelShowsVariantRows(model)).toBe(true);
  });

  it('hides variant rows when select options exist (use Options submenu)', () => {
    const model: FlatModel = {
      ...COMPOSER_MODEL,
      options: [
        {
          id: 'reasoning',
          label: 'Reasoning',
          type: 'select',
          options: [
            { id: 'low', label: 'Low' },
            { id: 'high', label: 'High' },
          ],
          defaultValue: 'low',
        },
      ],
      variants: [
        { label: 'Codex 5.1 Max', params: [{ id: 'reasoning', value: 'low' }] },
        { label: 'Codex 5.1 Max', params: [{ id: 'reasoning', value: 'high' }] },
      ],
    };
    expect(modelShowsVariantRows(model)).toBe(false);
    expect(modelShowsSubmenu(model)).toBe(true);
  });
});

describe('modelShowsSubmenu', () => {
  it('is true for boolean-only models with fast', () => {
    expect(modelShowsSubmenu(COMPOSER_MODEL)).toBe(true);
  });

  it('is true when select options exist', () => {
    expect(modelShowsSubmenu(OPUS_MODEL)).toBe(true);
  });
});

describe('plainRowOptions', () => {
  it('defaults boolean-only models to fast=false', () => {
    expect(plainRowOptions(COMPOSER_MODEL)).toEqual({ fast: false });
  });

  it('synthesizes fast=false when only fast variants exist', () => {
    const variantOnly: FlatModel = {
      ...COMPOSER_MODEL,
      options: undefined,
    };
    expect(plainRowOptions(variantOnly)).toEqual({ fast: false });
  });
});

describe('activeModelOptionBadges', () => {
  it('omits fast and reasoning effort from text badges', () => {
    expect(activeModelOptionBadges(COMPOSER_MODEL, { fast: true })).toEqual([]);
    expect(activeModelOptionBadges(OPUS_MODEL, { thinkingLevel: 'high' })).toEqual([]);
    expect(activeModelOptionBadges(CODEX_MODEL, { reasoningEffort: 'xhigh' })).toEqual([]);
  });

  it('keeps context-style selects as text badges', () => {
    const model: FlatModel = {
      ...OPUS_MODEL,
      id: 'cursor:claude-opus-4-6',
      providerId: 'cursor',
      providerName: 'Cursor',
      options: [
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
      ],
    };
    expect(activeModelOptionBadges(model, { context: '1M' })).toEqual([
      { id: 'context', label: '1M' },
    ]);
  });
});

describe('formatModelPickerLabel', () => {
  it('appends active option badges after the model name', () => {
    const model: FlatModel = {
      ...OPUS_MODEL,
      id: 'cursor:claude-opus-4-6',
      providerId: 'cursor',
      providerName: 'Cursor',
      options: [
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
        {
          id: 'reasoning',
          label: 'Reasoning',
          type: 'select',
          options: [
            { id: 'high', label: 'High', isDefault: true },
            { id: 'xhigh', label: 'Max' },
          ],
          defaultValue: 'high',
        },
      ],
    };
    expect(
      formatModelPickerLabel(model, { context: '1M', reasoning: 'xhigh' }),
    ).toBe('Claude Opus 4.6 1M');
  });

  it('includes fast in the accessible label when enabled', () => {
    expect(formatModelPickerLabel(COMPOSER_MODEL, { fast: true })).toBe('Composer 2.5 Fast');
  });

  it('omits reasoning effort from the trigger label', () => {
    expect(formatModelPickerLabel(OPUS_MODEL, { thinkingLevel: 'high' })).toBe(
      'Claude Opus 4.6',
    );
    expect(formatModelPickerLabel(CODEX_MODEL, { reasoningEffort: 'xhigh' })).toBe('GPT 5.5');
  });

  it('omits default thinking from the trigger label', () => {
    expect(formatModelPickerLabel(OPUS_MODEL, { thinkingLevel: 'medium' })).toBe(
      'Claude Opus 4.6',
    );
  });

  it('shows reasoning high next to glm-style models', () => {
    const glm: FlatModel = {
      id: 'cursor:glm-5.2',
      name: 'GLM 5.2',
      providerId: 'cursor',
      providerName: 'Cursor',
      groupId: 'cursor',
      groupName: 'Cursor',
      options: [
        {
          id: 'reasoning',
          label: 'Reasoning',
          type: 'select',
          options: [
            { id: 'high', label: 'High', isDefault: true },
            { id: 'max', label: 'Max' },
          ],
          defaultValue: 'high',
        },
      ],
    };
    expect(formatModelPickerLabel(glm, { reasoning: 'high' })).toBe('GLM 5.2');
  });
});

describe('modelIsBooleanOnly', () => {
  it('is true for composer-style models', () => {
    expect(modelIsBooleanOnly(COMPOSER_MODEL)).toBe(true);
  });

  it('is false when select options exist', () => {
    expect(modelIsBooleanOnly(OPUS_MODEL)).toBe(false);
  });
});

describe('mergeOptionsForModel', () => {
  it('drops unsupported options when switching models', () => {
    expect(mergeOptionsForModel(COMPOSER_MODEL, { fast: true })).toEqual({ fast: true });
    expect(
      mergeOptionsForModel(
        {
          ...COMPOSER_MODEL,
          id: 'cursor:claude-opus-4-8',
          name: 'claude-opus-4-8',
          options: undefined,
          variants: undefined,
        },
        { fast: true },
      ),
    ).toEqual({});
  });
});

describe('modelOptionsEqual', () => {
  it('treats missing and empty as equal', () => {
    expect(modelOptionsEqual(undefined, {})).toBe(true);
  });
});
