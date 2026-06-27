export interface ModelInfo {
  id: string;
  name: string;
  sub?: string;
  badge?: string;
  cost?: string;
}

export interface ModelGroup {
  id: string;
  name: string;
  sub?: string;
  badge?: string;
  models: ModelInfo[];
}

export interface ModelProvider {
  id: string;
  name: string;
  sub?: string;
  icon?: string;
  unavailable?: boolean;
  groups?: ModelGroup[];
}

/** Static fallback — mirrors mockup.html PROVIDERS */
export const FALLBACK_PROVIDERS: ModelProvider[] = [
  {
    id: 'pi',
    name: 'Pi',
    sub: 'Local harness · ~/.pi/agent',
    icon: 'π',
    groups: [
      {
        id: 'cliproxy',
        name: 'cliproxy',
        sub: 'localhost:8317 · default',
        models: [
          { id: 'claude-fable-5', name: 'Fable 5', sub: 'Most capable', badge: 'xhigh', cost: '$10 / $50' },
          { id: 'claude-opus-4-8', name: 'Opus 4.8', sub: 'CTO + tester pattern', badge: 'xhigh', cost: '$5 / $25' },
          { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', sub: 'Scout fallback', badge: 'high', cost: '$3 / $15' },
          { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', sub: 'Cheap + quick', badge: 'low', cost: '$1.5 / $9' },
        ],
      },
      {
        id: 'anthropic-oauth',
        name: 'Anthropic (Claude)',
        sub: 'OAuth · signed in',
        badge: 'oauth',
        models: [
          { id: 'anthropic:claude-opus-4', name: 'Claude Opus 4', sub: 'Most capable', badge: 'xhigh', cost: '$15 / $75' },
          { id: 'anthropic:claude-sonnet-4', name: 'Claude Sonnet 4', sub: 'Balanced', badge: 'high', cost: '$3 / $15' },
          { id: 'anthropic:claude-haiku-4', name: 'Claude Haiku 4', sub: 'Fast + cheap', badge: 'low', cost: '$0.25 / $1.25' },
        ],
      },
      {
        id: 'openai-codex-oauth',
        name: 'ChatGPT Plus/Pro (Codex)',
        sub: 'OAuth · signed in',
        badge: 'oauth',
        models: [
          { id: 'codex:gpt-5.5-high', name: 'GPT 5.5 High', sub: 'Reasoning · high', badge: 'high', cost: '$5 / $20' },
          { id: 'codex:gpt-5.5-low', name: 'GPT 5.5 Low', sub: 'Reasoning · low', badge: 'low', cost: '$2 / $8' },
          { id: 'codex:gpt-5', name: 'GPT 5', sub: 'Standard', badge: 'med', cost: '$3 / $12' },
        ],
      },
    ],
  },
  {
    id: 'anthropic-direct',
    name: 'Anthropic',
    sub: 'Direct API · bring your own key',
    icon: 'A',
    unavailable: true,
  },
  {
    id: 'openai-direct',
    name: 'OpenAI',
    sub: 'Direct API · bring your own key',
    icon: 'O',
    unavailable: true,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    sub: 'Local SDK · @cursor/sdk',
    icon: '◆',
    groups: [
      {
        id: 'cursor',
        name: 'Cursor',
        sub: 'Local runtime',
        models: [{ id: 'cursor:composer-2.5', name: 'Composer 2.5', sub: 'Cursor model' }],
      },
    ],
  },
];

export interface FlatModel extends ModelInfo {
  providerId: string;
  providerName: string;
  groupId: string;
  groupName: string;
}

export function flattenProviders(providers: ModelProvider[]): FlatModel[] {
  const out: FlatModel[] = [];
  for (const p of providers) {
    for (const g of p.groups ?? []) {
      for (const m of g.models) {
        out.push({ ...m, providerId: p.id, providerName: p.name, groupId: g.id, groupName: g.name });
      }
    }
  }
  return out;
}

export function modelById(providers: ModelProvider[]): Record<string, FlatModel> {
  return Object.fromEntries(flattenProviders(providers).map((m) => [m.id, m]));
}

export function providerMeta(
  providerId: string,
  providers: ModelProvider[] = FALLBACK_PROVIDERS,
): { name: string; icon: string } {
  const found = providers.find((p) => p.id === providerId);
  if (found) {
    return { name: found.name, icon: found.icon ?? (providerId[0]?.toUpperCase() ?? '?') };
  }
  return { name: providerId, icon: providerId[0]?.toUpperCase() ?? '?' };
}

const MODEL_ACRONYMS: Record<string, string> = {
  gpt: 'GPT',
  glm: 'GLM',
};

/**
 * Prettify a raw model slug into a human-readable name.
 * - "composer-2.5" → "Composer 2.5"
 * - "gpt-5.5" → "GPT 5.5"
 * - "claude-opus-4-8" → "Claude Opus 4 8"
 * Names that already contain a space are assumed nice (e.g. "Claude Haiku 3.5") and returned as-is.
 */
export function prettyModelName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes(' ')) return trimmed;
  return trimmed
    .split('-')
    .map((word) => {
      const lower = word.toLowerCase();
      if (MODEL_ACRONYMS[lower]) return MODEL_ACRONYMS[lower];
      if (/^[0-9.]+$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

export function sanitizeCursorModels(providers: ModelProvider[]): ModelProvider[] {
  return providers.map((p) => {
    if (p.id !== 'cursor' || !p.groups) return p;
    return {
      ...p,
      groups: p.groups.map((g) => ({
        ...g,
        models: g.models.filter((m) => !isCursorDefaultModelId(m.id)),
      })),
    };
  });
}

function isCursorDefaultModelId(id: string): boolean {
  const bare = id.startsWith('cursor:') ? id.slice('cursor:'.length) : id;
  return bare === 'default';
}

export const DEFAULT_PROVIDER_ID = 'cursor';
export const DEFAULT_MODEL_ID = 'cursor:composer-2.5';

/** Provider menu order — cursor first (matches defaultId + Synara-style preference). */
export const DEFAULT_PROVIDER_ORDER = ['cursor', 'pi', 'mock'] as const;

export function compareProvidersByOrder(
  leftId: string,
  rightId: string,
  order: readonly string[] = DEFAULT_PROVIDER_ORDER,
): number {
  const leftIndex = order.indexOf(leftId);
  const rightIndex = order.indexOf(rightId);
  const normalizedLeftIndex =
    leftIndex >= 0 ? leftIndex : DEFAULT_PROVIDER_ORDER.indexOf(leftId as (typeof DEFAULT_PROVIDER_ORDER)[number]) + order.length;
  const normalizedRightIndex =
    rightIndex >= 0
      ? rightIndex
      : DEFAULT_PROVIDER_ORDER.indexOf(rightId as (typeof DEFAULT_PROVIDER_ORDER)[number]) + order.length;
  if (normalizedLeftIndex !== normalizedRightIndex) {
    return normalizedLeftIndex - normalizedRightIndex;
  }
  return leftId.localeCompare(rightId);
}

function sortModelsInProvider(provider: ModelProvider): ModelProvider {
  if (!provider.groups?.length) return provider;
  return {
    ...provider,
    groups: [...provider.groups]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((group) => ({
        ...group,
        models: [...group.models].sort((a, b) =>
          prettyModelName(a.name).localeCompare(prettyModelName(b.name), undefined, {
            sensitivity: 'base',
          }),
        ),
      })),
  };
}

export function sortModelProviders(providers: ModelProvider[]): ModelProvider[] {
  return [...providers]
    .map(sortModelsInProvider)
    .sort((a, b) => {
      const aUnavailable = a.unavailable === true;
      const bUnavailable = b.unavailable === true;
      if (aUnavailable !== bUnavailable) return aUnavailable ? 1 : -1;
      return compareProvidersByOrder(a.id, b.id);
    });
}

export function normalizeModelCatalog(providers: ModelProvider[]): ModelProvider[] {
  return sortModelProviders(sanitizeCursorModels(providers));
}
