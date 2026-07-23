import { describe, it, expect } from 'bun:test';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';
import type { SubscriptionHostService } from '../../../src/subscription-host/subscription-host.service';
import { configurePiSdkMock } from './pi-sdk.mock';

const fakeRegistry = {
  getError: () => undefined,
  getAvailable: () => [] as unknown[],
  getProviderDisplayName: (provider: string) => provider,
  find: () => undefined,
  registerProvider: () => {},
  unregisterProvider: () => {},
  getAll: () => [],
};

configurePiSdkMock({
  AuthStorage: { create: () => ({}) },
  ModelRegistry: {
    create: () => fakeRegistry,
    inMemory: () => fakeRegistry,
  },
  SettingsManager: { create: () => ({}) },
  DefaultResourceLoader: class {
    async reload() {}
  },
  getAgentDir: () => '/tmp/fake-pi',
});

function makeSubscriptionHost() {
  const calls: unknown[] = [];
  const host = {
    applyToPiRegistry: async (registry: unknown) => {
      calls.push(registry);
    },
    mergeIntoNuncioEngineCatalog: async (catalog: unknown) => catalog,
  } as unknown as SubscriptionHostService;
  return { host, calls };
}

describe('PiAgentProvider subscription-host wiring', () => {
  it('registers the host catalog onto the registry when listing models', async () => {
    const { host, calls } = makeSubscriptionHost();
    const settingsStub = { resolve: () => undefined } as never;
    const provider = new PiAgentProvider(
      {} as never,
      {} as never,
      settingsStub,
      undefined,
      undefined,
      undefined,
      host,
    );

    await provider.listModels();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(fakeRegistry);
  });

  it('registers the host catalog when resolving availability', async () => {
    const { host, calls } = makeSubscriptionHost();
    const settingsStub = { resolve: () => undefined } as never;
    const provider = new PiAgentProvider(
      {} as never,
      {} as never,
      settingsStub,
      undefined,
      undefined,
      undefined,
      host,
    );

    await provider.isAvailable();

    expect(calls).toHaveLength(1);
  });
});
