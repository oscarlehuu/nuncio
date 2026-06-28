import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadModelPreference,
  MODEL_PREFERENCE_STORAGE_KEY,
  resolveModelSelection,
  saveModelPreference,
} from './model-preference';
import type { ModelProvider } from './model-providers';

const CURSOR_AND_PI: ModelProvider[] = [
  {
    id: 'pi',
    name: 'Pi',
    groups: [{ id: 'g', name: 'G', models: [{ id: 'anthropic:claude-haiku-4', name: 'Haiku' }] }],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    groups: [
      {
        id: 'c',
        name: 'C',
        models: [
          {
            id: 'cursor:codex-5.1-max',
            name: 'Codex 5.1 Max',
            options: [
              { id: 'fast', label: 'Fast', type: 'boolean', defaultValue: false },
              {
                id: 'reasoning',
                label: 'Reasoning',
                type: 'select',
                options: [
                  { id: 'low', label: 'Low', isDefault: true },
                  { id: 'high', label: 'High' },
                ],
                defaultValue: 'low',
              },
            ],
          },
          { id: 'cursor:composer-2.5', name: 'Composer 2.5' },
        ],
      },
    ],
  },
];

describe('model-preference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips model + provider + options through localStorage', () => {
    saveModelPreference({
      modelId: 'cursor:codex-5.1-max',
      providerId: 'cursor',
      modelOptions: { fast: true, reasoning: 'high' },
    });
    expect(loadModelPreference()).toEqual({
      modelId: 'cursor:codex-5.1-max',
      providerId: 'cursor',
      modelOptions: { fast: true, reasoning: 'high' },
    });
  });

  it('restores a stored selection when the model is still in the catalog', () => {
    const resolved = resolveModelSelection(CURSOR_AND_PI, {
      modelId: 'cursor:codex-5.1-max',
      providerId: 'cursor',
      modelOptions: { fast: true, reasoning: 'high' },
    });
    expect(resolved).toEqual({
      modelId: 'cursor:codex-5.1-max',
      providerId: 'cursor',
      modelOptions: { fast: true, reasoning: 'high' },
    });
  });

  it('falls back to catalog default when the stored model is gone', () => {
    const resolved = resolveModelSelection(CURSOR_AND_PI, {
      modelId: 'cursor:removed-model',
      providerId: 'cursor',
    });
    expect(resolved?.modelId).toBe('cursor:codex-5.1-max');
    expect(resolved?.providerId).toBe('cursor');
  });

  it('falls back when provider id does not match the stored model', () => {
    const resolved = resolveModelSelection(CURSOR_AND_PI, {
      modelId: 'cursor:composer-2.5',
      providerId: 'pi',
    });
    expect(resolved?.modelId).toBe('cursor:codex-5.1-max');
    expect(resolved?.providerId).toBe('cursor');
  });

  it('uses catalog default when nothing is stored', () => {
    expect(localStorage.getItem(MODEL_PREFERENCE_STORAGE_KEY)).toBeNull();
    const resolved = resolveModelSelection(CURSOR_AND_PI, null);
    expect(resolved?.modelId).toBe('cursor:codex-5.1-max');
  });
});
