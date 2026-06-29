import { Injectable } from '@nestjs/common';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionsRepository } from '../sessions/persistence/sessions.repository';
import {
  parseTranscriptLine,
  titleFromTurn,
  type ParsedTranscriptTurn,
} from './cursor-transcript.parser';
import {
  agentTranscriptsRoot,
  toProjectSlug,
  transcriptDirForChat,
} from './cursor-project-slug';
import {
  chatStoreMtime as resolveChatStoreMtime,
  readCursorChatNames as resolveCursorChatNames,
  readCursorChatMetadata as resolveCursorChatMetadata,
} from './cursor-chat-store';
import type { LocalCursorSessionDto } from './cursor-local-sessions.types';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

@Injectable()
export class CursorLocalSessionsService {
  constructor(private readonly sessions: SessionsRepository) {}

  listForWorkspace(workspace: string, limit = DEFAULT_LIMIT): LocalCursorSessionDto[] {
    const abs = workspace.trim();
    if (!abs) return [];
    const slug = toProjectSlug(abs);
    const root = join(agentTranscriptsRoot(this.homeDir()), slug, 'agent-transcripts');
    if (!existsSync(root)) return [];

    const cap = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const entries: LocalCursorSessionDto[] = [];
    const cursorNames = resolveCursorChatNames(this.homeDir());

    for (const chatId of readdirSync(root, { withFileTypes: true })) {
      if (!chatId.isDirectory()) continue;
      if (chatId.name === 'subagents') continue;
      const jsonlPath = join(root, chatId.name, `${chatId.name}.jsonl`);
      if (!existsSync(jsonlPath)) continue;

      const meta = this.readTranscriptMeta(jsonlPath);
      if (meta.messageCount === 0) continue;

      const imported = this.sessions.findByCursorChatId(chatId.name, 'cli');
      entries.push({
        chatId: chatId.name,
        workspace: abs,
        projectSlug: slug,
        title: cursorNames.get(chatId.name) ?? meta.title,
        preview: meta.preview,
        updatedAt: statSync(jsonlPath).mtimeMs,
        messageCount: meta.messageCount,
        alreadyImported: Boolean(imported),
        nuncioSessionId: imported?.id,
      });
    }

    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    return entries.slice(0, cap);
  }

  find(chatId: string, workspace: string): LocalCursorSessionDto | null {
    const items = this.listForWorkspace(workspace, MAX_LIMIT);
    return items.find((item) => item.chatId === chatId) ?? null;
  }

  readTranscript(chatId: string, workspace: string): ParsedTranscriptTurn[] {
    const slug = toProjectSlug(workspace);
    const jsonlPath = join(transcriptDirForChat(this.homeDir(), slug, chatId), `${chatId}.jsonl`);
    if (!existsSync(jsonlPath)) return [];

    const lines = readFileSync(jsonlPath, 'utf8').split('\n');
    const turns: ParsedTranscriptTurn[] = [];
    for (const line of lines) {
      const turn = parseTranscriptLine(line);
      if (turn) turns.push(turn);
    }
    return turns;
  }

  /** For active-run heuristic: transcript file mtime in ms. */
  transcriptMtime(chatId: string, workspace: string): number | null {
    const slug = toProjectSlug(workspace);
    const jsonlPath = join(transcriptDirForChat(this.homeDir(), slug, chatId), `${chatId}.jsonl`);
    if (!existsSync(jsonlPath)) return null;
    return statSync(jsonlPath).mtimeMs;
  }

  /** True when the last JSONL entry is `turn_ended` — agent is idle, not running. */
  isTranscriptTurnEnded(chatId: string, workspace: string): boolean {
    const slug = toProjectSlug(workspace);
    const jsonlPath = join(transcriptDirForChat(this.homeDir(), slug, chatId), `${chatId}.jsonl`);
    if (!existsSync(jsonlPath)) return false;
    const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    if (lines.length === 0) return false;
    try {
      const last = JSON.parse(lines[lines.length - 1]!);
      return last.type === 'turn_ended' || last.role === 'turn_ended';
    } catch {
      return false;
    }
  }

  /** For active-run heuristic: CLI checkpoint store.db mtime in ms. */
  chatStoreMtime(chatId: string): number | null {
    return resolveChatStoreMtime(this.homeDir(), chatId);
  }

  /** Best-effort model from the transcript JSONL. Returns null for CLI sessions (model is not stored). */
  readTranscriptModel(chatId: string, workspace: string): string | null {
    const slug = toProjectSlug(workspace);
    const jsonlPath = join(transcriptDirForChat(this.homeDir(), slug, chatId), `${chatId}.jsonl`);
    if (existsSync(jsonlPath)) {
      const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const parsed = JSON.parse(lines[i]!) as {
            role?: string;
            model?: string;
            message?: { model?: string };
          };
          if (parsed.role !== 'assistant') continue;
          const model = parsed.model ?? parsed.message?.model;
          if (model?.trim()) return model.trim();
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  /** Override for tests. */
  homeDir(): string {
    return homedir();
  }

  private readTranscriptMeta(jsonlPath: string): {
    title: string;
    preview: string | null;
    messageCount: number;
  } {
    const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    let title = 'Imported Cursor chat';
    let preview: string | null = null;
    let messageCount = 0;

    for (const line of lines) {
      const turn = parseTranscriptLine(line);
      if (!turn) continue;
      messageCount += 1;
      if (turn.role === 'user' && title === 'Imported Cursor chat') {
        title = titleFromTurn(turn);
      }
      if (turn.role === 'assistant' && turn.text) {
        preview = turn.text.length > 120 ? `${turn.text.slice(0, 117)}...` : turn.text;
      }
    }

    return { title, preview, messageCount };
  }
}
