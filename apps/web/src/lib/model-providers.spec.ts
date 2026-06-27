import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  FALLBACK_PROVIDERS,
  flattenProviders,
  modelById,
  normalizeModelCatalog,
  prettyModelName,
  sanitizeCursorModels,
  sortModelProviders,
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
    expect(DEFAULT_MODEL_ID).toBe('cursor:composer-2.5');
    expect(DEFAULT_PROVIDER_ID).toBe('cursor');
  });
});

describe('FALLBACK_PROVIDERS cursor entry', () => {
  it('includes a cursor provider mirroring the backend static catalog', () => {
    const cursor = FALLBACK_PROVIDERS.find((p) => p.id === 'cursor');
    expect(cursor).toBeDefined();
    expect(cursor?.name).toBe('Cursor');
    expect(cursor?.icon).toBeDefined();
    const flat = flattenProviders([cursor!]);
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.every((m) => m.providerId === 'cursor')).toBe(true);
    expect(flat.some((m) => m.id.startsWith('cursor:'))).toBe(true);
  });

  it('cursor fallback model resolves through modelById', () => {
    const lookup = modelById(FALLBACK_PROVIDERS);
    const cursorModel = flattenProviders(FALLBACK_PROVIDERS).find((m) =>
      m.id.startsWith('cursor:'),
    );
    expect(cursorModel).toBeDefined();
    expect(cursorModel!.id).toBe('cursor:composer-2.5');
    expect(lookup[cursorModel!.id]).toBeDefined();
  });
});

describe('sanitizeCursorModels', () => {
  it('removes cursor default model entries from the catalog', () => {
    const providers: ModelProvider[] = [
      {
        id: 'cursor',
        name: 'Cursor',
        groups: [
          {
            id: 'cursor',
            name: 'Cursor',
            models: [
              { id: 'cursor:default', name: 'default' },
              { id: 'cursor:composer-2.5', name: 'composer-2.5' },
            ],
          },
        ],
      },
    ];
    const sanitized = sanitizeCursorModels(providers);
    expect(flattenProviders(sanitized).map((m) => m.id)).toEqual(['cursor:composer-2.5']);
  });
});

describe('sortModelProviders', () => {
  it('orders cursor before pi regardless of input order', () => {
    const providers: ModelProvider[] = [
      { id: 'pi', name: 'Pi', groups: [{ id: 'g', name: 'G', models: [{ id: 'm1', name: 'M1' }] }] },
      { id: 'cursor', name: 'Cursor', groups: [{ id: 'g', name: 'G', models: [{ id: 'm2', name: 'M2' }] }] },
    ];
    expect(sortModelProviders(providers).map((p) => p.id)).toEqual(['cursor', 'pi']);
  });

  it('places mock after cursor and pi', () => {
    const providers: ModelProvider[] = [
      { id: 'mock', name: 'Mock', groups: [{ id: 'g', name: 'G', models: [{ id: 'm0', name: 'M0' }] }] },
      { id: 'pi', name: 'Pi', groups: [{ id: 'g', name: 'G', models: [{ id: 'm1', name: 'M1' }] }] },
      { id: 'cursor', name: 'Cursor', groups: [{ id: 'g', name: 'G', models: [{ id: 'm2', name: 'M2' }] }] },
    ];
    expect(sortModelProviders(providers).map((p) => p.id)).toEqual(['cursor', 'pi', 'mock']);
  });

  it('sorts unavailable providers after available ones', () => {
    const providers: ModelProvider[] = [
      { id: 'anthropic-direct', name: 'Anthropic', unavailable: true },
      { id: 'cursor', name: 'Cursor', groups: [{ id: 'g', name: 'G', models: [{ id: 'm', name: 'M' }] }] },
    ];
    expect(sortModelProviders(providers).map((p) => p.id)).toEqual(['cursor', 'anthropic-direct']);
  });

  it('sorts models alphabetically by display name within each group', () => {
    const providers: ModelProvider[] = [
      {
        id: 'cursor',
        name: 'Cursor',
        groups: [
          {
            id: 'cursor',
            name: 'Cursor',
            models: [
              { id: 'cursor:claude-opus-4-8', name: 'claude-opus-4-8' },
              { id: 'cursor:composer-2.5', name: 'composer-2.5' },
            ],
          },
        ],
      },
    ];
    const sorted = sortModelProviders(providers);
    expect(sorted[0].groups![0].models.map((m) => m.id)).toEqual([
      'cursor:claude-opus-4-8',
      'cursor:composer-2.5',
    ]);
  });

  it('sorts groups alphabetically within a provider', () => {
    const providers: ModelProvider[] = [
      {
        id: 'pi',
        name: 'Pi',
        groups: [
          { id: 'z', name: 'Zulu', models: [{ id: 'm-z', name: 'Z Model' }] },
          { id: 'a', name: 'Alpha', models: [{ id: 'm-a', name: 'A Model' }] },
        ],
      },
    ];
    const sorted = sortModelProviders(providers);
    expect(sorted[0].groups!.map((g) => g.id)).toEqual(['a', 'z']);
  });
});

describe('normalizeModelCatalog', () => {
  it('sanitizes cursor defaults then sorts providers and models', () => {
    const providers: ModelProvider[] = [
      {
        id: 'pi',
        name: 'Pi',
        groups: [{ id: 'g', name: 'G', models: [{ id: 'pi:m', name: 'pi-model' }] }],
      },
      {
        id: 'cursor',
        name: 'Cursor',
        groups: [
          {
            id: 'cursor',
            name: 'Cursor',
            models: [
              { id: 'cursor:default', name: 'default' },
              { id: 'cursor:composer-2.5', name: 'composer-2.5' },
            ],
          },
        ],
      },
    ];
    const catalog = normalizeModelCatalog(providers);
    expect(catalog.map((p) => p.id)).toEqual(['cursor', 'pi']);
    expect(flattenProviders(catalog).map((m) => m.id)).toEqual([
      'cursor:composer-2.5',
      'pi:m',
    ]);
  });
});

describe('prettyModelName', () => {
  it('prettifies a dashed slug by replacing - with spaces and capitalizing', () => {
    expect(prettyModelName('composer-2.5')).toBe('Composer 2.5');
  });

  it('expands known acronyms (gpt → GPT, glm → GLM)', () => {
    expect(prettyModelName('gpt-5.5')).toBe('GPT 5.5');
    expect(prettyModelName('glm-5.2')).toBe('GLM 5.2');
  });

  it('capitalizes each word in a multi-segment slug', () => {
    expect(prettyModelName('claude-opus-4-8')).toBe('Claude Opus 4 8');
    expect(prettyModelName('gemini-3.5-flash')).toBe('Gemini 3.5 Flash');
    expect(prettyModelName('grok-4.20-0309-non-reasoning')).toBe('Grok 4.20 0309 Non Reasoning');
  });

  it('capitalizes a bare single-word slug', () => {
    expect(prettyModelName('default')).toBe('Default');
    expect(prettyModelName('composer-2')).toBe('Composer 2');
  });

  it('leaves already-nice names (with spaces) untouched', () => {
    expect(prettyModelName('Claude Haiku 3.5')).toBe('Claude Haiku 3.5');
    expect(prettyModelName('Fable 5 (Most Capable)')).toBe('Fable 5 (Most Capable)');
  });

  it('handles empty input', () => {
    expect(prettyModelName('')).toBe('');
  });
});
