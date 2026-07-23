import type { SubscriptionHostModel } from './subscription-host.types';

/**
 * The pi `Api` type is `KnownApi | (string & {})`. The SDK does not re-export its
 * `ProviderConfigInput`/`Api` from the package root, so this module mirrors just
 * the shape `ModelRegistry.registerProvider` consumes. The registrar cast at the
 * call site keeps it structurally compatible with the real SDK signature.
 */
export type PiApi =
  | 'openai-completions'
  | 'mistral-conversations'
  | 'openai-responses'
  | 'azure-openai-responses'
  | 'openai-codex-responses'
  | 'anthropic-messages'
  | 'bedrock-converse-stream'
  | 'google-generative-ai'
  | 'google-vertex'
  | (string & {});

/** Provider name the host's catalog registers under in the Pi ModelRegistry. */
export const SUBSCRIPTION_HOST_PROVIDER_ID = 'subscription-host';

interface PiModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One entry of the registered provider's `models[]`, mirroring ProviderConfigInput. */
interface SubscriptionHostProviderModel {
  id: string;
  name: string;
  api: PiApi;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  cost: PiModelCost;
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
}

/** Provider config passed to `ModelRegistry.registerProvider`. */
export interface SubscriptionHostProviderConfig {
  name: string;
  baseUrl: string;
  authHeader: boolean;
  models: SubscriptionHostProviderModel[];
}

/** Minimal seam over the Pi SDK ModelRegistry used to register/tear down routing. */
export interface PiProviderRegistrar {
  registerProvider(providerName: string, config: SubscriptionHostProviderConfig): void;
  unregisterProvider(providerName: string): void;
  /** Built-in + custom models, used to reuse metadata for matching ids. */
  getAll?(): SubscriptionHostBuiltinModel[];
}

/** The subset of a Pi built-in model whose metadata a matching host model reuses. */
export interface SubscriptionHostBuiltinModel {
  id: string;
  reasoning?: boolean;
  input?: Array<'text' | 'image'>;
  cost?: PiModelCost;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
}

const KNOWN_APIS: readonly string[] = [
  'openai-completions',
  'mistral-conversations',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'anthropic-messages',
  'bedrock-converse-stream',
  'google-generative-ai',
  'google-vertex',
];

/**
 * Map the `api` field the router returns per model to the pi `Api` type. A value
 * that is already a known pi api id passes through; otherwise it is classified by
 * family, defaulting to the most widely compatible OpenAI Chat Completions shape.
 */
export function mapRouterApiToPiApi(api?: string): PiApi {
  const raw = (api ?? '').trim().toLowerCase();
  if (!raw) return 'openai-completions';
  if (KNOWN_APIS.includes(raw)) return raw as PiApi;
  if (raw.includes('anthropic') || raw.includes('claude') || raw.includes('messages')) {
    return 'anthropic-messages';
  }
  if (raw.includes('codex')) return 'openai-codex-responses';
  if (raw.includes('responses')) return 'openai-responses';
  if (raw.includes('google') || raw.includes('gemini') || raw.includes('generative') || raw.includes('vertex')) {
    return 'google-generative-ai';
  }
  return 'openai-completions';
}

type ApiFamily = 'anthropic' | 'google' | 'openai';

function apiFamily(api: PiApi): ApiFamily {
  if (api === 'anthropic-messages' || api === 'bedrock-converse-stream') return 'anthropic';
  if (api === 'google-generative-ai' || api === 'google-vertex') return 'google';
  return 'openai';
}

interface DefaultMetadata {
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  cost: PiModelCost;
  contextWindow: number;
  maxTokens: number;
}

/**
 * Conservative metadata defaults keyed by api family. The router does NOT return
 * contextWindow/maxTokens/cost/reasoning/input, so these are documented, safe
 * placeholders — NOT exact per-model limits — to refine later (out of scope here).
 * Cost is zeroed because subscription-billed models are not metered per token.
 */
function defaultMetadataForApi(api: PiApi): DefaultMetadata {
  const zeroCost: PiModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  switch (apiFamily(api)) {
    case 'anthropic':
      return { reasoning: false, input: ['text'], cost: zeroCost, contextWindow: 200_000, maxTokens: 8_192 };
    case 'google':
      return { reasoning: false, input: ['text'], cost: zeroCost, contextWindow: 1_000_000, maxTokens: 8_192 };
    default:
      return { reasoning: false, input: ['text'], cost: zeroCost, contextWindow: 128_000, maxTokens: 16_384 };
  }
}

/**
 * Build the Pi ModelRegistry provider config for the subscription host: its
 * loopback `/v1` endpoint as the baseUrl (no bearer — the router runs --no-auth),
 * with one model entry per catalog row. Where a host model id equals a known
 * built-in, that built-in's real metadata wins over the family defaults.
 */
export function buildSubscriptionHostProviderConfig(
  routerBaseUrl: string,
  models: SubscriptionHostModel[],
  builtinFor?: (id: string) => SubscriptionHostBuiltinModel | undefined,
): SubscriptionHostProviderConfig {
  const baseUrl = `${routerBaseUrl.replace(/\/+$/, '')}/v1`;
  return {
    name: 'Subscription models',
    baseUrl,
    // Loopback router runs with --no-auth (#156): no Authorization header. If the
    // router later requires auth, read the token from the host's store here.
    authHeader: false,
    models: models.map((model): SubscriptionHostProviderModel => {
      const api = mapRouterApiToPiApi(model.api);
      const builtin = builtinFor?.(model.id);
      const defaults = defaultMetadataForApi(api);
      return {
        id: model.id,
        name: model.displayName,
        // Transport api is always the router's; only the router-absent metadata
        // falls back to a matching built-in or the family defaults.
        api,
        reasoning: builtin?.reasoning ?? defaults.reasoning,
        input: builtin?.input ?? defaults.input,
        cost: builtin?.cost ?? defaults.cost,
        contextWindow: builtin?.contextWindow ?? defaults.contextWindow,
        maxTokens: builtin?.maxTokens ?? defaults.maxTokens,
        ...(builtin?.thinkingLevelMap ? { thinkingLevelMap: builtin.thinkingLevelMap } : {}),
      };
    }),
  };
}

/** Look up a built-in model by id across the registry's full catalog. */
export function buildBuiltinLookup(
  registry: PiProviderRegistrar,
): (id: string) => SubscriptionHostBuiltinModel | undefined {
  const all = registry.getAll?.() ?? [];
  const byId = new Map(all.map((model) => [model.id, model]));
  return (id) => byId.get(id);
}
