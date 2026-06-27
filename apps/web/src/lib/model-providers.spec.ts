import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MODEL_ID,
  FALLBACK_PROVIDERS,
  flattenProviders,
  modelById,
  type ModelProvider,
} from './model-providers';

describe('flattenProviders', () => {
  it('flattens provider → group → model with the parent ids attached', () => {
    const providers: ModelProvider[] = [
      {
        id: 'pi',
        name: 'Pi',
        groups: [
          { id: 'g1', name: 'G1', models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] },
        ],
      },
      { id: 'empty', name: 'Empty' }, // no groups -> contributes nothing
    ];
    const flat = flattenProviders(providers);
    expect(flat).toHaveLength(2);
    expect(flat[0]).toMatchObject({
      id: 'm1',
      providerId: 'pi',
      providerName: 'Pi',
      groupId: 'g1',
      groupName: 'G1',
    });
    expect(flat[1].id).toBe('m2');
  });

  it('returns [] when no provider has groups', () => {
    expect(flattenProviders([{ id: 'a', name: 'A' }])).toEqual([]);
  });
});

describe('modelById', () => {
  it('maps model id → flat model', () => {
    const lookup = modelById([
      { id: 'pi', name: 'Pi', groups: [{ id: 'g', name: 'G', models: [{ id: 'm1', name: 'M1' }] }] },
    ]);
    expect(lookup['m1'].name).toBe('M1');
    expect(lookup['m1'].providerId).toBe('pi');
    expect(lookup['nope']).toBeUndefined();
  });

  it('DEFAULT_MODEL_ID resolves against the fallback catalog', () => {
    const lookup = modelById(FALLBACK_PROVIDERS);
    expect(lookup[DEFAULT_MODEL_ID]).toBeDefined();
  });
});
