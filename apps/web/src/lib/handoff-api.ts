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

export interface LocalPiSession {
  sessionId: string;
  path: string;
  workspace: string;
  title: string;
  preview: string | null;
  updatedAt: number;
  messageCount: number;
  alreadyImported: boolean;
  nuncioSessionId?: string;
}

export interface LocalHandoffSession {
  source: 'cursor' | 'pi';
  key: string;
  title: string;
  preview: string | null;
  updatedAt: number;
  messageCount: number;
  alreadyImported: boolean;
  nuncioSessionId?: string;
  workspace: string;
  cursorChatId?: string;
  piSessionPath?: string;
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

export async function fetchLocalPiSessions(
  workspace: string,
): Promise<LocalPiSession[]> {
  const params = new URLSearchParams({ workspace });
  const res = await fetch(`/api/pi/local-sessions?${params}`);
  if (!res.ok) {
    throw new HandoffApiError(res.status, 'Failed to load Pi sessions on this Mac');
  }
  const body = (await res.json()) as { items: LocalPiSession[] };
  return body.items;
}

export async function fetchAllLocalSessions(
  workspace: string,
): Promise<LocalHandoffSession[]> {
  const results = await Promise.allSettled([
    fetchLocalPiSessions(workspace),
    fetchLocalCursorSessions(workspace),
  ]);

  const allRejected = results.every((r) => r.status === 'rejected');
  if (allRejected) {
    throw (results[0] as PromiseRejectedResult).reason;
  }

  const sessions: LocalHandoffSession[] = [];

  const piResult = results[0];
  if (piResult.status === 'fulfilled') {
    for (const item of piResult.value) {
      sessions.push({
        source: 'pi',
        key: `pi:${item.path}`,
        title: item.title,
        preview: item.preview,
        updatedAt: item.updatedAt,
        messageCount: item.messageCount,
        alreadyImported: item.alreadyImported,
        nuncioSessionId: item.nuncioSessionId,
        workspace: item.workspace,
        piSessionPath: item.path,
      });
    }
  }

  const cursorResult = results[1];
  if (cursorResult.status === 'fulfilled') {
    for (const item of cursorResult.value) {
      sessions.push({
        source: 'cursor',
        key: `cursor:${item.chatId}`,
        title: item.title,
        preview: item.preview,
        updatedAt: item.updatedAt,
        messageCount: item.messageCount,
        alreadyImported: item.alreadyImported,
        nuncioSessionId: item.nuncioSessionId,
        workspace: item.workspace,
        cursorChatId: item.chatId,
      });
    }
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export type HandoffInput = {
  workspace: string;
  title?: string;
} & (
  | { cursorChatId: string; piSessionPath?: never }
  | { piSessionPath: string; cursorChatId?: never }
);

export async function handoffSession(input: HandoffInput): Promise<Session> {
  const res = await fetch('/api/sessions/handoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new HandoffApiError(
      res.status,
      handoffErrorMessage(res.status, text || 'Failed to import session'),
    );
  }
  return res.json();
}
