import { Injectable } from '@nestjs/common';
import { AgentRegistry } from '../agents/agents.registry';
import type { ModelProviderDto } from './models.types';

@Injectable()
export class ModelsService {
  constructor(private readonly agents: AgentRegistry) {}

  async list(): Promise<ModelProviderDto[]> {
    const providers = await this.agents.available();
    const modelLists = await Promise.all(providers.map((provider) => provider.listModels()));
    return modelLists.flat();
  }
}
