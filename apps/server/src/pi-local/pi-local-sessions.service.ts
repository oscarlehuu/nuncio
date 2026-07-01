import { Injectable } from '@nestjs/common';
import { existsSync, statSync } from 'node:fs';
import { SessionManager, type SessionEntry, type SessionInfo } from '@earendil-works/pi-coding-agent';
import { SessionsRepository } from '../sessions/persistence/sessions.repository';
import { piEntriesToSessionEvents } from './pi-transcript-hydrate';
import type { LocalPiSessionDto } from './pi-local-sessions.types';

type PiSdk = typeof import('@earendil-works/pi-coding-agent');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

@Injectable()
export class PiLocalSessionsService {
  constructor(private readonly sessions: SessionsRepository) {}

  /** Override for tests. */
  loadSdk = async (): Promise<PiSdk> => import('@earendil-works/pi-coding-agent');

  /** Override for tests. */
  openSession = (path: string): Pick<SessionManager, 'getEntries' | 'buildSessionContext'> =>
    SessionManager.open(path);

  async listForWorkspace(workspace: string, limit = DEFAULT_LIMIT): Promise<LocalPiSessionDto[]> {
    const abs = workspace.trim();
    if (!abs) return [];

    const cap = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const pi = await this.loadSdk();
    let infos: SessionInfo[];
    try {
      infos = await pi.SessionManager.list(abs);
    } catch {
      return [];
    }
    const items = infos.map((info) => this.toDto(info, abs));
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return items.slice(0, cap);
  }

  async find(path: string, workspace: string): Promise<LocalPiSessionDto | null> {
    const target = path.trim();
    if (!target) return null;
    const listed = await this.listForWorkspace(workspace, MAX_LIMIT);
    const found = listed.find((item) => item.path === target);
    if (found) return found;
    return this.readSessionDto(target, workspace.trim());
  }

  readTranscriptEvents(path: string): Array<{ type: string; payload: unknown }> {
    try {
      const manager = this.openSession(path);
      return piEntriesToSessionEvents(manager.getEntries() as SessionEntry[]);
    } catch {
      return [];
    }
  }

  readModelMeta(path: string): { model: string | null; thinkingLevel: string | null } {
    try {
      const ctx = this.openSession(path).buildSessionContext();
      return {
        model: ctx.model ? `${ctx.model.provider}:${ctx.model.modelId}` : null,
        thinkingLevel: ctx.thinkingLevel ?? null,
      };
    } catch {
      return { model: null, thinkingLevel: null };
    }
  }

  transcriptMtime(path: string): number | null {
    if (!existsSync(path)) return null;
    return statSync(path).mtimeMs;
  }

  private readSessionDto(path: string, workspace: string): LocalPiSessionDto | null {
    try {
      const manager = SessionManager.open(path);
      const entries = manager.getEntries() as SessionEntry[];
      const sessionId = manager.getSessionId?.() ?? path;
      const title = manager.getSessionName?.() ?? titleFromEntries(entries) ?? 'Imported Pi session';
      const preview = previewFromEntries(entries);
      const stat = existsSync(path) ? statSync(path) : null;
      const imported = this.sessions.findByProviderThreadId(path);
      return {
        sessionId,
        path,
        workspace: manager.getCwd?.() || workspace,
        title,
        preview,
        updatedAt: stat?.mtimeMs ?? Date.now(),
        messageCount: countMessages(entries),
        alreadyImported: Boolean(imported),
        ...(imported ? { nuncioSessionId: imported.id } : {}),
      };
    } catch {
      return null;
    }
  }

  private toDto(info: SessionInfo, requestedWorkspace: string): LocalPiSessionDto {
    const imported = this.sessions.findByProviderThreadId(info.path);
    return {
      sessionId: info.id,
      path: info.path,
      workspace: info.cwd || requestedWorkspace,
      title: info.name?.trim() || titleFromText(info.firstMessage) || 'Imported Pi session',
      preview: previewFromText(info.firstMessage),
      updatedAt: info.modified.getTime(),
      messageCount: info.messageCount,
      alreadyImported: Boolean(imported),
      ...(imported ? { nuncioSessionId: imported.id } : {}),
    };
  }
}

function titleFromText(text: string | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split('\n')[0] ?? trimmed;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function previewFromText(text: string | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

function titleFromEntries(entries: SessionEntry[]): string | null {
  for (const entry of entries as Array<{ type?: string; message?: { role?: string; content?: unknown } }>) {
    if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
    return titleFromText(textFromContent(entry.message.content));
  }
  return null;
}

function previewFromEntries(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
    const preview = previewFromText(textFromContent(entry.message.content));
    if (preview) return preview;
  }
  return null;
}

function countMessages(entries: SessionEntry[]): number {
  return entries.filter((entry) => entry.type === 'message').length;
}

function textFromContent(content: unknown): string {
  const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [content] : [];
  return blocks
    .map((block) => {
      if (typeof block === 'string') return block;
      if (
        typeof block === 'object' &&
        block !== null &&
        !Array.isArray(block) &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        return (block as { text: string }).text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}
