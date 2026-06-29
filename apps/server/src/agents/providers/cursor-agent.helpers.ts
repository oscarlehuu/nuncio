import type { ModelProviderDto } from '../../models/models.types';

export const CURSOR_PREFERRED_MODEL = 'composer-2.5';

export function isCursorDefaultModelId(id: string): boolean {
  const bare = id.startsWith('cursor:') ? id.slice('cursor:'.length) : id;
  return bare === 'default';
}

export function isCursorToolCallError(
  toolCall: { status?: string; isError?: boolean } | undefined,
): boolean {
  if (!toolCall) return false;
  if (toolCall.isError === true) return true;
  const status = toolCall.status?.toLowerCase();
  return status === 'error' || status === 'failed';
}

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
        models: [
          {
            id: `cursor:${CURSOR_PREFERRED_MODEL}`,
            name: 'Composer 2.5',
            sub: 'Cursor model',
          },
        ],
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

export type CursorInteractionUpdate = {
  type: string;
  text?: string;
  thinkingDurationMs?: number;
  toolCall?: {
    id?: string;
    type?: string;
    status?: string;
    isError?: boolean;
    args?: unknown;
    result?: unknown;
  };
};

export type CursorAgentInstance = {
  send: (
    text: string,
    options?: { onDelta?: (args: { update: CursorInteractionUpdate }) => void },
  ) => Promise<CursorRunInstance>;
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
  accumulatedThinking: string;
  thinkingOpen: boolean;
  thinkingId?: string;
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
