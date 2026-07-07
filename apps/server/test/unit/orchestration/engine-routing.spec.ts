import { resolveRoute, type EngineRoutingDeps } from '../../../src/orchestration/engine-routing';

function deps(over: Partial<EngineRoutingDeps> = {}): EngineRoutingDeps {
  return {
    routingJson: JSON.stringify({
      mechanical: { provider: 'cursor', model: 'cursor:fast' },
      review: { provider: 'codex', avoidAuthorProvider: true },
      design: { provider: 'pi' },
    }),
    availableProviderIds: async () => ['cursor', 'codex', 'pi'],
    ...over,
  };
}

describe('resolveRoute', () => {
  it('hits a tag and returns its provider + model', async () => {
    const route = await resolveRoute('mechanical', 'pi', deps());
    expect(route).toEqual({ provider: 'cursor', model: 'cursor:fast' });
  });

  it('misses an unknown tag → null', async () => {
    expect(await resolveRoute('unknown', 'pi', deps())).toBeNull();
  });

  it('returns null when there is no routing table', async () => {
    expect(await resolveRoute('mechanical', 'pi', deps({ routingJson: undefined }))).toBeNull();
    expect(await resolveRoute('mechanical', 'pi', deps({ routingJson: '' }))).toBeNull();
  });

  it('undefined/null tag → null', async () => {
    expect(await resolveRoute(undefined, 'pi', deps())).toBeNull();
  });

  it('avoidAuthorProvider swaps to the first other available provider', async () => {
    // review routes to codex, avoidAuthor true; author is codex → swap to a non-codex available provider.
    const route = await resolveRoute('review', 'codex', deps());
    expect(route?.provider).not.toBe('codex');
    expect(['cursor', 'pi']).toContain(route?.provider);
  });

  it('avoidAuthorProvider keeps the routed provider when no other is available', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const route = await resolveRoute('review', 'codex', deps({ availableProviderIds: async () => ['codex'] }));
      // Only codex available → keep it, with a logged note.
      expect(route?.provider).toBe('codex');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not swap when the author differs from the routed provider', async () => {
    const route = await resolveRoute('review', 'pi', deps());
    expect(route?.provider).toBe('codex');
  });

  it('falls through (null) when the routed provider is unavailable', async () => {
    const route = await resolveRoute('mechanical', 'pi', deps({ availableProviderIds: async () => ['codex', 'pi'] }));
    expect(route).toBeNull(); // cursor not available → never strand a task
  });

  it('malformed JSON → null and exactly one warning, never throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const route = await resolveRoute('mechanical', 'pi', deps({ routingJson: '{not json' }));
      expect(route).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a route entry without a provider → null (nothing to route to)', async () => {
    const route = await resolveRoute('design', 'pi', deps({ routingJson: JSON.stringify({ design: { model: 'm' } }) }));
    expect(route).toBeNull();
  });
});
