import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadModelPreference,
  loadRecentModels,
  MODEL_PREFERENCE_STORAGE_KEY,
  MODEL_RECENTS_STORAGE_KEY,
  recordRecentModel,
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
    expect(resolved?.modelId).toBe('anthropic:claude-haiku-4');
    expect(resolved?.providerId).toBe('pi');
  });

  it('falls back when provider id does not match the stored model', () => {
    const resolved = resolveModelSelection(CURSOR_AND_PI, {
      modelId: 'cursor:composer-2.5',
      providerId: 'pi',
    });
    expect(resolved?.modelId).toBe('anthropic:claude-haiku-4');
    expect(resolved?.providerId).toBe('pi');
  });

  it('uses catalog default when nothing is stored', () => {
    expect(localStorage.getItem(MODEL_PREFERENCE_STORAGE_KEY)).toBeNull();
    const resolved = resolveModelSelection(CURSOR_AND_PI, null);
    expect(resolved?.modelId).toBe('anthropic:claude-haiku-4');
  });
});

describe('recent models', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns [] when nothing is stored, storage throws, or JSON is corrupt', () => {
    expect(loadRecentModels()).toEqual([]);
    localStorage.setItem(MODEL_RECENTS_STORAGE_KEY, 'not-json{');
    expect(loadRecentModels()).toEqual([]);
    localStorage.setItem(MODEL_RECENTS_STORAGE_KEY, '{"modelId":"x"}');
    expect(loadRecentModels()).toEqual([]);
  });

  it('drops malformed entries and caps the list at the limit', () => {
    localStorage.setItem(
      MODEL_RECENTS_STORAGE_KEY,
      JSON.stringify([
        { modelId: 'a', providerId: 'p' },
        { modelId: 42 },
        null,
        { modelId: 'b', providerId: 'p' },
        { modelId: 'c', providerId: 'p' },
        { modelId: 'd', providerId: 'p' },
      ]),
    );
    expect(loadRecentModels()).toEqual([
      { modelId: 'a', providerId: 'p' },
      { modelId: 'b', providerId: 'p' },
      { modelId: 'c', providerId: 'p' },
    ]);
  });

  it('records most-recent-first, dedupes by modelId, and caps at the limit', () => {
    recordRecentModel({ modelId: 'a', providerId: 'p' });
    recordRecentModel({ modelId: 'b', providerId: 'p' });
    recordRecentModel({ modelId: 'a', providerId: 'p' });
    expect(loadRecentModels()).toEqual([
      { modelId: 'a', providerId: 'p' },
      { modelId: 'b', providerId: 'p' },
    ]);
    recordRecentModel({ modelId: 'c', providerId: 'q' });
    recordRecentModel({ modelId: 'd', providerId: 'q' });
    expect(loadRecentModels()).toEqual([
      { modelId: 'd', providerId: 'q' },
      { modelId: 'c', providerId: 'q' },
      { modelId: 'a', providerId: 'p' },
    ]);
  });
});
