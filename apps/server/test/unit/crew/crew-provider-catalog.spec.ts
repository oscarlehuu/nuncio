import { CrewProviderCatalogService } from '../../../src/crew/crew-provider-catalog.service';

describe('CrewProviderCatalogService', () => {
  it('builds a fresh Crew catalog from available providers and excludes Cursor', async () => {
    const provider = (id: string, runtimePolicies: unknown[], models: string[]) => ({
      id, capabilities: { runtimePolicies },
      listModels: async () => [{
        id, name: id, groups: [{ id: 'g', name: 'g', models: models.map((model) => ({ id: model, name: model })) }],
      }],
    });
    const agents = {
      available: async () => [
        provider('pi', [
          { filesystem: 'read-only', network: 'disabled' },
          { filesystem: 'workspace-write', network: 'disabled' },
        ], ['pi:model']),
        provider('cursor', [], ['cursor:model']),
        provider('mock', [
          { filesystem: 'read-only', network: 'disabled' },
          { filesystem: 'workspace-write', network: 'disabled' },
        ], ['mock:default']),
      ],
    };
    const catalog = await new CrewProviderCatalogService(agents as never).list();
    expect(catalog).toEqual([
      {
        provider: 'pi', models: ['pi:model'], runtimePolicies: ['read-only', 'workspace-write'],
        testOnly: false,
      },
      {
        provider: 'mock', models: ['mock:default'], runtimePolicies: ['read-only', 'workspace-write'],
        testOnly: true,
      },
    ]);
  });

  it('re-reads availability and model catalogs on each resolution', async () => {
    let model = 'claude:old';
    const agents = {
      available: async () => [{
        id: 'claude', capabilities: { runtimePolicies: [{ filesystem: 'read-only', network: 'disabled' }] },
        listModels: async () => [{
          id: 'claude', name: 'Claude', groups: [{ id: 'g', name: 'g', models: [{ id: model, name: model }] }],
        }],
      }],
    };
    const source = new CrewProviderCatalogService(agents as never);
    expect((await source.list())[0]?.models).toEqual(['claude:old']);
    model = 'claude:new';
    expect((await source.list())[0]?.models).toEqual(['claude:new']);
  });
});
