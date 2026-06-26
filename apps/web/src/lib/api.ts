export type SessionStatus = 'CREATED' | 'RUNNING' | 'IDLE' | 'ERROR';

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

export async function createSession(prompt: string): Promise<Session> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) throw new Error('Failed to create session');
  return res.json();
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
