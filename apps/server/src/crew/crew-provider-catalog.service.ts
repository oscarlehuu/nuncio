import { Injectable } from '@nestjs/common';
import { AgentRegistry } from '../agents/agents.registry';
import type { CrewProviderCapability } from './domain/crew.types';

@Injectable()
export class CrewProviderCatalogService {
  constructor(private readonly agents: AgentRegistry) {}
  async list(): Promise<CrewProviderCapability[]> {
    const available = await this.agents.available();
    const crewProviders = available.filter((provider) =>
      ['pi', 'codex', 'claude', 'mock'].includes(provider.id),
    );
    return Promise.all(crewProviders.map(async (provider) => {
      const catalogs = await provider.listModels().catch(() => []);
      const models = [...new Set(catalogs.flatMap((catalog) =>
        (catalog.groups ?? []).flatMap((group) => group.models.map((model) => model.id)),
      ))];
      const runtimePolicies = [...new Set((provider.capabilities.runtimePolicies ?? [])
        .filter((policy) => policy.network === 'disabled')
        .map((policy) => policy.filesystem))];
      return {
        provider: provider.id,
        models,
        runtimePolicies,
        testOnly: provider.id === 'mock',
      } satisfies CrewProviderCapability;
    }));
  }
}
