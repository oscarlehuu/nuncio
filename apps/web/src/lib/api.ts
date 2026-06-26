import type { ModelProvider } from './model-providers';
import { FALLBACK_PROVIDERS } from './model-providers';

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
  model: string | null;
  prompt: string;
  preview: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch('/api/sessions');
  if (!res.ok) throw new Error('Failed to load sessions');
  return res.json();
}

export async function createSession(prompt: string, model?: string): Promise<Session> {
  const body: { prompt: string; model?: string } = { prompt };
  if (model) body.model = model;

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

export async function fetchModels(): Promise<ModelProvider[]> {
  try {
    const res = await fetch('/api/models');
    if (!res.ok) return FALLBACK_PROVIDERS;
    const data = await res.json();
    if (Array.isArray(data)) return data as ModelProvider[];
    if (Array.isArray(data?.providers)) return data.providers as ModelProvider[];
    return FALLBACK_PROVIDERS;
  } catch {
    return FALLBACK_PROVIDERS;
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
