import type { ModelProviderDto } from '../../models/models.types';

export const STATIC_FALLBACK_CURSOR_MODELS: ModelProviderDto[] = [
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
        models: [{ id: 'cursor:composer-2', name: 'Composer 2', sub: 'Default' }],
      },
    ],
  },
];

export type CursorSdk = {
  Agent: {
    create: (options: unknown) => Promise<CursorAgentInstance>;
  };
  Cursor: {
    models: {
      list: (options: { apiKey: string }) => Promise<Array<{ id: string }>>;
    };
  };
  JsonlLocalAgentStore: new (dir: string) => unknown;
};

export type CursorAgentInstance = {
  send: (text: string) => Promise<CursorRunInstance>;
  close?: () => void;
};

export type CursorRunInstance = {
  id: string;
  stream: () => AsyncGenerator<{ type: string; [key: string]: unknown }, void>;
  wait: () => Promise<{
    id: string;
    status: 'finished' | 'error' | 'cancelled';
    result?: string;
    durationMs?: number;
  }>;
};

export type CursorSessionHandle = {
  agent: CursorAgentInstance;
  accumulatedText: string;
};

export function parseCursorModel(model: string | null | undefined): string | undefined {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  if (!trimmed) return undefined;
  if (trimmed.startsWith('cursor:')) {
    const rest = trimmed.slice('cursor:'.length).trim();
    return rest || undefined;
  }
  return trimmed;
}
