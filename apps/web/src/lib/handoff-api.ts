import type { Session } from './api';

export interface LocalCursorSession {
  chatId: string;
  workspace: string;
  projectSlug: string;
  title: string;
  preview: string | null;
  updatedAt: number;
  messageCount: number;
  alreadyImported: boolean;
  nuncioSessionId?: string;
}

export class HandoffApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HandoffApiError';
    this.status = status;
  }
}

export function handoffErrorMessage(status: number, fallback: string): string {
  switch (status) {
    case 409:
      return 'Cursor is still running this chat on your Mac. Pause it there, then retry.';
    case 503:
      return 'Cursor CLI not found. Install it or set NUNCIO_CURSOR_AGENT_BIN in Settings.';
    case 404:
      return 'This Cursor chat no longer exists on your Mac.';
    default:
      return fallback;
  }
}

export async function fetchLocalCursorSessions(
  workspace: string,
): Promise<LocalCursorSession[]> {
  const params = new URLSearchParams({ workspace });
  const res = await fetch(`/api/cursor/local-sessions?${params}`);
  if (!res.ok) {
    throw new HandoffApiError(res.status, handoffErrorMessage(res.status, 'Failed to load Cursor sessions on this Mac'));
  }
  const body = (await res.json()) as { items: LocalCursorSession[] };
  return body.items;
}

export async function handoffSession(input: {
  cursorChatId: string;
  workspace: string;
  title?: string;
}): Promise<Session> {
  const res = await fetch('/api/sessions/handoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new HandoffApiError(
      res.status,
      handoffErrorMessage(res.status, text || 'Failed to import Cursor session'),
    );
  }
  return res.json();
}
