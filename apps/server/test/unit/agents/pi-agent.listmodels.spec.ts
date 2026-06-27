import { describe, it, expect, mock } from 'bun:test';
import { STATIC_MODEL_PROVIDERS } from '../../../src/models/models.static';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';

type FakeModel = { provider: string; id: string; name: string; cost?: { input: number; output: number } };

let availableModels: FakeModel[] = [];
let throwOnCreate = false;

const fakeRegistry = {
  getAvailable: () => availableModels,
  getProviderDisplayName: (provider: string) => provider.toUpperCase(),
  find: (provider: string, id: string) =>
    (availableModels.find((m) => m.provider === provider && m.id === id) as unknown) ?? undefined,
};

// Intercept the lazily-imported Pi SDK so listModels() runs against a
// controllable registry without touching real auth or the network.
mock.module('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: { create: () => ({}) },
  ModelRegistry: {
    create: () => {
      if (throwOnCreate) throw new Error('sdk broken');
      return fakeRegistry;
    },
  },
  getAgentDir: () => '/tmp/fake-pi',
}));

function makeProvider(): PiAgentProvider {
  return new PiAgentProvider({} as never, {} as never);
}

describe('PiAgentProvider.listModels', () => {
  it('groups registry models by provider with provider:modelId ids and cost formatting', async () => {
    availableModels = [
      { provider: 'anthropic', id: 'claude-x', name: 'Claude X', cost: { input: 3, output: 15 } },
      { provider: 'openai-codex', id: 'gpt-y', name: 'GPT Y' },
    ];
    throwOnCreate = false;

    const models = await makeProvider().listModels();

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('pi');
    const groups = models[0].groups ?? [];
    expect(groups).toHaveLength(2);
    const flat = groups.flatMap((g) => g.models);
    expect(flat.map((m) => m.id)).toEqual(expect.arrayContaining(['anthropic:claude-x', 'openai-codex:gpt-y']));
    const claude = flat.find((m) => m.id === 'anthropic:claude-x');
    expect(claude?.name).toBe('Claude X');
    expect(claude?.cost).toBe('$3 / $15');
  });

  it('falls back to static providers when the registry has no available models', async () => {
    availableModels = [];
    throwOnCreate = false;

    const models = await makeProvider().listModels();

    expect(models).toBe(STATIC_MODEL_PROVIDERS);
  });

  it('falls back to static providers when the SDK throws', async () => {
    throwOnCreate = true;

    const models = await makeProvider().listModels();

    expect(models).toBe(STATIC_MODEL_PROVIDERS);
    throwOnCreate = false;
  });
});
