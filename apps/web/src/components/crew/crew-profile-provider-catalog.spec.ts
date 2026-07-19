import { describe, expect, it } from 'vitest';
import type { ModelProvider } from '../../lib/model-providers';
import { crewProfileProviderCatalog } from './crew-profile-provider-catalog';

const provider = (id: string): ModelProvider => ({ id, name: id, groups: [] });

describe('crewProfileProviderCatalog', () => {
  it('excludes generic providers outside Crew MVP from the profile editor', () => {
    expect(crewProfileProviderCatalog([
      provider('pi'), provider('cursor'), provider('codex'), provider('claude'), provider('devin'),
    ]).map(({ id }) => id)).toEqual(['pi', 'codex', 'claude', 'devin']);
  });

  it('retains mock only when the supplied forced catalog explicitly exposes it', () => {
    expect(crewProfileProviderCatalog([provider('mock')]).map(({ id }) => id)).toEqual(['mock']);
    expect(crewProfileProviderCatalog([provider('pi')]).map(({ id }) => id)).toEqual(['pi']);
  });
});
