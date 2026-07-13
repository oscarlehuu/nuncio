import { describe, it, expect, mock } from 'bun:test';
import { PiAgentProvider } from '../../../src/agents/providers/pi-agent.provider';

type FakeModel = {
  provider: string;
  id: string;
  name: string;
  input?: Array<'text' | 'image'>;
  cost?: { input: number; output: number };
  contextWindow?: number;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
};

let availableModels: FakeModel[] = [];
let throwOnCreate = false;
let providerDisplayNames: Record<string, string> = {};
let registryFactory: 'file' | 'memory' | null = null;
let registryModelsPath: string | undefined;
let registryLoadError: string | undefined;

const fakeRegistry = {
  getError: () => registryLoadError,
  getAvailable: () => availableModels,
  getProviderDisplayName: (provider: string) => providerDisplayNames[provider] ?? provider,
  find: (provider: string, id: string) =>
    (availableModels.find((m) => m.provider === provider && m.id === id) as unknown) ?? undefined,
};

// Intercept the lazily-imported Pi SDK so listModels() runs against a
// controllable registry without touching real auth or the network.
mock.module('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: { create: () => ({}) },
  ModelRegistry: {
    create: (_authStorage: unknown, modelsPath?: string) => {
      registryFactory = 'file';
      registryModelsPath = modelsPath;
      if (throwOnCreate) throw new Error('sdk broken');
      return fakeRegistry;
    },
    inMemory: () => {
      registryFactory = 'memory';
      if (throwOnCreate) throw new Error('sdk broken');
      return fakeRegistry;
    },
  },
  SettingsManager: { create: () => ({}) },
  DefaultResourceLoader: class {
    async reload() {}
  },
  getAgentDir: () => '/tmp/fake-pi',
}));

function makeProvider(resolve: (key: string) => string | undefined = () => undefined): PiAgentProvider {
  // Minimal SettingsService stub: resolve() returns undefined for every key,
  // so the provider falls back to the mocked SDK's getAgentDir() ('/tmp/fake-pi')
  // and is never short-circuited by NUNCIO_FORCE_MOCK.
  const settingsStub = { resolve } as never;
  return new PiAgentProvider({} as never, {} as never, settingsStub);
}

describe('PiAgentProvider.listModels', () => {
  it('loads an optional Nuncio-only models file without reading the Pi CLI models.json', async () => {
    availableModels = [{
      provider: 'custom-proxy',
      id: 'claude-opus-4-8',
      name: 'Claude Opus 4.8',
      reasoning: true,
      thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    }];
    registryFactory = null;
    registryModelsPath = undefined;
    throwOnCreate = false;

    const providers = await makeProvider().listModels();

    expect(registryFactory as 'file' | 'memory' | null).toBe('file');
    expect(registryModelsPath as string | undefined).toBe('/tmp/fake-pi/nuncio-models.json');
    expect(providers[0]?.sub).toBe('Optional models file · shared Pi auth');
    expect(providers[0]?.groups?.[0]?.name).toBe('custom-proxy');
  });

  it('allows a user-specific Nuncio models path override', async () => {
    availableModels = [];
    registryModelsPath = undefined;

    await makeProvider((key) => key === 'NUNCIO_PI_MODELS_PATH'
      ? '/tmp/user-config/models.json'
      : undefined).listModels();

    expect(registryModelsPath as string | undefined).toBe('/tmp/user-config/models.json');
  });

  it('resolves a relative models path inside the active Pi agent directory', async () => {
    registryModelsPath = undefined;

    await makeProvider((key) => key === 'NUNCIO_PI_MODELS_PATH'
      ? 'private/models.json'
      : undefined).listModels();

    expect(registryModelsPath as string | undefined).toBe('/tmp/fake-pi/private/models.json');
  });

  it('leaves a home-relative models path for the Pi SDK to expand', async () => {
    registryModelsPath = undefined;

    await makeProvider((key) => key === 'NUNCIO_PI_MODELS_PATH'
      ? '~/.config/nuncio/models.json'
      : undefined).listModels();

    expect(registryModelsPath as string | undefined).toBe('~/.config/nuncio/models.json');
  });

  it('keeps built-in models available when the optional custom file is missing', async () => {
    registryLoadError = undefined;
    availableModels = [{ provider: 'anthropic', id: 'claude-built-in', name: 'Claude built-in' }];

    const providers = await makeProvider().listModels();

    expect(providers[0]?.groups?.[0]?.models?.[0]?.id).toBe('anthropic:claude-built-in');
  });

  it('warns once per invalid models path without exposing config contents', async () => {
    availableModels = [];
    registryLoadError = 'Invalid apiKey: sk-private-value';
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));

    try {
      const provider = makeProvider((key) => key === 'NUNCIO_PI_MODELS_PATH'
        ? '/tmp/invalid-private-models.json'
        : undefined);
      await provider.listModels();
      await provider.listModels();
    } finally {
      console.warn = originalWarn;
      registryLoadError = undefined;
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/tmp/invalid-private-models.json');
    expect(warnings[0]).not.toContain('sk-private-value');
  });

  it('groups registry models by provider with provider:modelId ids, cost formatting, and context windows', async () => {
    availableModels = [
      {
        provider: 'anthropic',
        id: 'claude-x',
        name: 'Claude X',
        cost: { input: 3, output: 15 },
        contextWindow: 1_000_000,
      },
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
    expect(claude?.contextWindow).toBe(1_000_000);
  });

  it('returns an empty stable response when the registry has no available models', async () => {
    availableModels = [];
    throwOnCreate = false;

    const models = await makeProvider().listModels();

    expect(models).toEqual([]);
  });

  it('exposes Max only when the Pi registry model explicitly supports it', async () => {
    availableModels = [
      {
        provider: 'openai-codex',
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        reasoning: true,
        thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
        contextWindow: 372_000,
      },
    ];
    throwOnCreate = false;

    const providers = await makeProvider().listModels();
    const model = providers[0]?.groups?.[0]?.models?.[0];
    const thinking = model?.options?.find((option) => option.id === 'thinkingLevel');

    expect(model?.id).toBe('openai-codex:gpt-5.6-sol');
    expect(model?.contextWindow).toBe(372_000);
    expect(thinking?.options?.map((option) => option.id)).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('surfaces every configured registry provider with stable grouping and model capabilities', async () => {
    providerDisplayNames = {
      anthropic: 'Anthropic',
      google: 'Google Gemini',
      xai: 'xAI',
    };
    availableModels = [
      {
        provider: 'xai',
        id: 'grok-4-fast',
        name: 'Grok 4 Fast',
        input: ['text'],
        reasoning: true,
        thinkingLevelMap: { minimal: null, xhigh: 'high', max: null },
      },
      {
        provider: 'google',
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        input: ['text', 'image'],
        reasoning: false,
      },
      {
        provider: 'anthropic',
        id: 'claude-sonnet',
        name: 'Claude Sonnet',
        input: ['text', 'image'],
        reasoning: true,
        thinkingLevelMap: { off: null, xhigh: null },
      },
      {
        provider: 'google',
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        input: ['text', 'image'],
        reasoning: true,
        thinkingLevelMap: { low: null, xhigh: 'high' },
      },
    ];
    throwOnCreate = false;

    const providers = await makeProvider().listModels();
    const groups = providers[0]?.groups ?? [];

    expect(groups.map((group) => [group.id, group.name])).toEqual([
      ['anthropic', 'Anthropic'],
      ['google', 'Google Gemini'],
      ['xai', 'xAI'],
    ]);
    expect(groups[1]?.models.map((model) => model.id)).toEqual([
      'google:gemini-2.5-flash',
      'google:gemini-2.5-pro',
    ]);
    expect(groups.some((group) => group.id === 'mistral')).toBe(false);

    const flat = groups.flatMap((group) => group.models);
    const geminiFlash = flat.find((model) => model.id === 'google:gemini-2.5-flash');
    const grok = flat.find((model) => model.id === 'xai:grok-4-fast');
    const claude = flat.find((model) => model.id === 'anthropic:claude-sonnet');
    const geminiPro = flat.find((model) => model.id === 'google:gemini-2.5-pro');

    expect(geminiFlash?.capabilities?.images).toBe(true);
    expect(grok?.capabilities?.images).toBe(false);
    expect(geminiFlash?.options).toBeUndefined();
    expect(
      grok?.options?.[0]?.options?.map((option) => option.id),
    ).toEqual(['off', 'low', 'medium', 'high', 'xhigh']);
    expect(
      claude?.options?.[0]?.options?.map((option) => option.id),
    ).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(
      geminiPro?.options?.[0]?.options?.map((option) => option.id),
    ).toEqual(['off', 'minimal', 'medium', 'high', 'xhigh']);
  });

  it('returns an empty stable response when the SDK throws', async () => {
    throwOnCreate = true;

    const models = await makeProvider().listModels();

    expect(models).toEqual([]);
    throwOnCreate = false;
  });
});
