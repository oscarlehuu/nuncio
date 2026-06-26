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

export const DEFAULT_MODEL_ID = 'claude-fable-5';
