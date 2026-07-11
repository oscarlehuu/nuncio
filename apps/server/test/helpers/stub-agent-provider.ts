import type { AgentProvider } from '../../src/agents/agents.types';

export function stubAgentProvider(
  id: string,
  name: string,
  available: boolean,
): AgentProvider {
  return {
    id,
    name,
    capabilities: { interrupt: false, modelSwitch: 'none', effortSwitch: 'none', images: false, steerWhileRunning: false },
    isAvailable: async () => available,
    listModels: async () => [],
    run: async () => undefined,
    steer: async () => undefined,
    quiesce: async () => undefined,
    dispose: () => undefined,
    bustCache: () => undefined,
  };
}
