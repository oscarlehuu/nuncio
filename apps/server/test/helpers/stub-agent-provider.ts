import type { AgentProvider } from '../../src/agents/agents.types';

export function stubAgentProvider(
  id: string,
  name: string,
  available: boolean,
): AgentProvider {
  return {
    id,
    name,
    isAvailable: async () => available,
    listModels: async () => [],
    run: async () => undefined,
    steer: async () => undefined,
    dispose: () => undefined,
    bustCache: () => undefined,
  };
}
