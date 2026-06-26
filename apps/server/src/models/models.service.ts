import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { STATIC_MODEL_PROVIDERS, type ModelGroupDto, type ModelItemDto, type ModelProviderDto } from './static-models';

@Injectable()
export class ModelsService {
  hasPiAuth(): boolean {
    const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
    return existsSync(join(agentDir, 'auth.json'));
  }

  async list(): Promise<ModelProviderDto[]> {
    if (process.env.NUNCIO_FORCE_MOCK === '1' || !this.hasPiAuth()) return STATIC_MODEL_PROVIDERS;
    try {
      const pi = await import('@earendil-works/pi-coding-agent');
      const authStorage = pi.AuthStorage.create();
      const modelRegistry = pi.ModelRegistry.create(authStorage);
      return this.fromRegistry(modelRegistry);
    } catch {
      return STATIC_MODEL_PROVIDERS;
    }
  }

  private fromRegistry(modelRegistry: {
    getAvailable: () => Array<{ provider: string; id: string; name: string; cost?: { input: number; output: number } }>;
    getProviderDisplayName: (provider: string) => string;
  }): ModelProviderDto[] {
    const models = modelRegistry.getAvailable();
    if (models.length === 0) return STATIC_MODEL_PROVIDERS;
    const byProvider = new Map<string, ModelItemDto[]>();
    for (const model of models) {
      const providerId = model.provider;
      const item: ModelItemDto = { id: providerId + ':' + model.id, name: model.name, sub: model.id };
      if (model.cost) item.cost = '$' + model.cost.input + ' / $' + model.cost.output;
      byProvider.set(providerId, [...(byProvider.get(providerId) ?? []), item]);
    }
    const providers: ModelProviderDto[] = [];
    for (const [providerId, groupModels] of byProvider) {
      providers.push({ id: providerId, name: modelRegistry.getProviderDisplayName(providerId), sub: 'Pi ModelRegistry', groups: [{ id: providerId, name: modelRegistry.getProviderDisplayName(providerId), models: groupModels }] });
    }
    return providers.length > 0 ? providers : STATIC_MODEL_PROVIDERS;
  }
}
