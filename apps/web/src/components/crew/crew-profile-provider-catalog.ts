import type { ModelProvider } from '../../lib/model-providers';

export function crewProfileProviderCatalog(providers: ModelProvider[]): ModelProvider[] {
  return providers.filter(({ id }) => ['pi', 'codex', 'claude', 'devin', 'mock'].includes(id));
}
