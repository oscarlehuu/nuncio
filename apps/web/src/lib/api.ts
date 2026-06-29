import type { ModelProvider } from './model-providers';
import type { ModelOptionsMap } from './model-options';
import { FALLBACK_PROVIDERS, normalizeModelCatalog } from './model-providers';

export type SessionStatus =
  | 'CREATED'
  | 'RUNNING'
  | 'IDLE'
  | 'PAUSED'
  | 'ARCHIVED'
  | 'ERROR';

export interface Session {
  id: string;
  title: string;
  status: SessionStatus;
  provider: string;
  model: string | null;
  modelOptions: ModelOptionsMap | null;
  prompt: string;
  preview: string | null;
  workspace: string | null;
  projectPath: string | null;
  baseBranch: string | null;
  worktreePath: string | null;
  branch: string | null;
  cursorBackend: 'sdk' | 'cli' | null;
  cursorChatId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export type ProviderRequestDecision = 'approve' | 'deny';

export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch('/api/sessions');
  if (!res.ok) throw new Error('Failed to load sessions');
  return res.json();
}

export async function fetchArchivedSessions(): Promise<Session[]> {
  const res = await fetch('/api/sessions?includeArchived=1');
  if (!res.ok) throw new Error('Failed to load archived sessions');
  const all = (await res.json()) as Session[];
  return all.filter((s) => s.status === 'ARCHIVED');
}

export async function createSession(
  prompt: string,
  model?: string,
  provider?: string,
  projectPath?: string,
  baseBranch?: string,
  modelOptions?: ModelOptionsMap,
  useWorktree = false,
): Promise<Session> {
  const body: {
    prompt: string;
    model?: string;
    provider?: string;
    workspace?: string;
    projectPath?: string;
    baseBranch?: string;
    modelOptions?: ModelOptionsMap;
    useWorktree?: boolean;
  } = { prompt };
  if (model) body.model = model;
  if (provider) body.provider = provider;
  if (projectPath) {
    body.projectPath = projectPath;
    if (baseBranch) body.baseBranch = baseBranch;
    if (useWorktree) {
      body.useWorktree = true;
    } else {
      body.workspace = projectPath;
    }
  }
  if (modelOptions && Object.keys(modelOptions).length > 0) body.modelOptions = modelOptions;

  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Failed to create session');
  return res.json();
}

export async function steerSession(id: string, message: string): Promise<Session> {
  const res = await fetch(`/api/sessions/${id}/steer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error('Failed to steer session');
  return res.json();
}

export async function pauseSession(id: string): Promise<Session> {
  const res = await fetch(`/api/sessions/${id}/pause`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to pause session');
  return res.json();
}

export async function archiveSession(id: string): Promise<Session> {
  const res = await fetch(`/api/sessions/${id}/archive`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to archive session');
  return res.json();
}

export async function restoreSession(id: string): Promise<Session> {
  const res = await fetch(`/api/sessions/${id}/restore`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to restore session');
  return res.json();
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete session');
}

export async function respondProviderRequest(
  sessionId: string,
  requestId: string,
  decision: ProviderRequestDecision,
): Promise<{ requestId: string; decision: ProviderRequestDecision }> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/provider-requests/${encodeURIComponent(requestId)}/respond`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    },
  );
  if (!res.ok) throw new Error('Failed to respond to provider request');
  return res.json();
}

export async function fetchModels(): Promise<ModelProvider[]> {
  try {
    const res = await fetch('/api/models');
    if (!res.ok) return normalizeModelCatalog(FALLBACK_PROVIDERS);
    const data = await res.json();
    if (Array.isArray(data)) return normalizeModelCatalog(data as ModelProvider[]);
    if (Array.isArray(data?.providers)) return normalizeModelCatalog(data.providers as ModelProvider[]);
    return normalizeModelCatalog(FALLBACK_PROVIDERS);
  } catch {
    return normalizeModelCatalog(FALLBACK_PROVIDERS);
  }
}

export async function fetchEvents(sessionId: string, since = 0): Promise<SessionEvent[]> {
  const res = await fetch(`/api/sessions/${sessionId}/events?since=${since}`);
  if (!res.ok) throw new Error('Failed to load events');
  return res.json();
}

export function statusLabel(status: SessionStatus): string {
  const map: Record<SessionStatus, string> = {
    CREATED: 'Created',
    RUNNING: 'Running',
    IDLE: 'Idle',
    PAUSED: 'Paused',
    ARCHIVED: 'Archived',
    ERROR: 'Error',
  };
  return map[status] ?? status;
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
