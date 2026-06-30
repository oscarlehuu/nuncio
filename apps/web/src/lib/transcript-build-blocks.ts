import type { SessionEvent } from './api';
import type { UserInputQuestion, UserInputResolvedBy } from './user-input.types';
import { summarizeToolCall, type ToolSummary } from './tool-summary';
import {
  isCursorContextMessage,
  parseCursorContextMessage,
  type CursorContextSection,
} from './cursor-context';
import {
  isInteractiveToolName,
  parseInteractiveToolInput,
} from './interactive-tool-input';

export type TranscriptBlock =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; streaming?: boolean }
  | {
      kind: 'tool';
      callId: string;
      tool: string;
      status: 'running' | 'done' | 'error';
      input?: unknown;
      output?: unknown;
      summary: ToolSummary;
    }
  | {
      kind: 'thinking';
      thinkingId: string;
      text: string;
      streaming?: boolean;
      collapsedDefault: true;
    }
  | {
      kind: 'cursor-context';
      summary: string;
      instruction: string;
      sections: CursorContextSection[];
    }
  | {
      kind: 'user_input';
      requestId: string;
      title?: string;
      questions: UserInputQuestion[];
      resolvedBy?: UserInputResolvedBy;
    }
  | { kind: 'error'; message: string };

interface OpenTool {
  callId: string;
  tool: string;
  input?: unknown;
  status: 'running' | 'done' | 'error';
  output?: unknown;
}

interface PendingInteractive {
  callId: string;
  requestId: string;
  title?: string;
  questions: UserInputQuestion[];
}

/** Strips Cursor's "[REDACTED]" placeholders from exported transcripts. */
function stripRedacted(text: string): string {
  // Drop standalone redacted blocks entirely.
  if (text.trim() === '[REDACTED]') return '';
  // Strip trailing/inline redacted markers.
  return text
    .replace(/\n*\[REDACTED\]\s*/g, ' ')
    .replace(/\[REDACTED\]/g, '')
    .trim();
}

/**
 * Cursor's JSONL stores the AI's internal thinking for the NEXT turn appended
 * to the current assistant message's text block (no separate type/metadata).
 * Detect and strip it so only the user-facing response remains.
 */
const THINKING_START_PATTERNS: RegExp[] = [
  /\n\nThe user/,
  /\n\nLet me /,
  /\n\nNow I /,
  /\n\nI need to /,
  /\n\nI should /,
  /\n\nI'll /,
  /\n\nI also /,
  /\n\nI want to /,
  /\n\nI can /,
  /\n\nI have /,
  /\n\nThis is a good/,
  /\n\nThis is a significant/,
  /\n\nThis is an architectural/,
  /\n\nThis is a (?:great|real|thin|transcript)/,
  /\n\nAll (?:tests|\d+|frontend|green)/,
  /\n\nBoth servers/,
  /\n\nBoth issues/,
];

/** Detect Vietnamese diacritics — used to find the response/thinking boundary. */
const VIETNAMESE_RE = /[\u1E00-\u1EFF\u0300-\u036F\u0110\u0111]/;
function hasVietnamese(text: string): boolean {
  return VIETNAMESE_RE.test(text);
}

function splitThinking(text: string): { response: string; thinking: string | null } {
  // Collect candidate split points from both heuristics, pick the earliest.

  // 1. Explicit thinking-start patterns.
  let patternIdx = -1;
  for (const pattern of THINKING_START_PATTERNS) {
    const match = text.match(pattern);
    if (match && match.index !== undefined && match.index > 0) {
      if (patternIdx === -1 || match.index < patternIdx) {
        patternIdx = match.index;
      }
    }
  }

  // 2. Language-switch fallback: last Vietnamese paragraph → English thinking.
  let langSwitchIdx = -1;
  const paragraphs = text.split('\n\n');
  if (paragraphs.length > 2) {
    let lastVietnameseIdx = -1;
    for (let i = 0; i < paragraphs.length; i++) {
      if (hasVietnamese(paragraphs[i]!)) {
        lastVietnameseIdx = i;
      }
    }
    if (lastVietnameseIdx >= 0 && lastVietnameseIdx < paragraphs.length - 1) {
      const thinking = paragraphs.slice(lastVietnameseIdx + 1).join('\n\n');
      if (thinking.length > 100) {
        langSwitchIdx = paragraphs.slice(0, lastVietnameseIdx + 1).join('\n\n').length;
      }
    }
  }

  // Use the earlier split point (catches more thinking).
  const splitIdx = patternIdx === -1
    ? langSwitchIdx
    : langSwitchIdx === -1
      ? patternIdx
      : Math.min(patternIdx, langSwitchIdx);

  if (splitIdx > 0) {
    return {
      response: text.slice(0, splitIdx).trim(),
      thinking: text.slice(splitIdx).trim(),
    };
  }

  return { response: text, thinking: null };
}

export function buildTranscriptBlocks(events: SessionEvent[]): TranscriptBlock[] {
  const out: TranscriptBlock[] = [];
  let assistantBuf = '';
  let thinkingBuf = '';
  let thinkingOpen = false;
  let thinkingId = '';
  const openTools = new Map<string, OpenTool>();
  const pendingInteractive = new Map<string, PendingInteractive>();
  const legacyStack: string[] = [];
  let legacySeq = 0;

  const flushAssistant = (streaming = false) => {
    const cleaned = stripRedacted(assistantBuf);
    if (!cleaned && !streaming) return;
    const { response, thinking } = splitThinking(cleaned || assistantBuf);
    if (response || streaming) {
      out.push({ kind: 'assistant', text: response, ...(streaming ? { streaming: true } : {}) });
    }
    if (thinking) {
      out.push({
        kind: 'thinking',
        thinkingId: 'imported-thinking',
        text: thinking,
        collapsedDefault: true,
      } as TranscriptBlock);
    }
    assistantBuf = '';
  };

  const flushThinking = (streaming = false) => {
    if (!thinkingOpen && !thinkingBuf.trim()) return;
    out.push({
      kind: 'thinking',
      thinkingId: thinkingId || 'thinking',
      text: thinkingBuf,
      collapsedDefault: true,
      ...(streaming ? { streaming: true } : {}),
    });
    thinkingBuf = '';
    thinkingOpen = false;
    thinkingId = '';
  };

  const resolveCallId = (payload: Record<string, unknown>, tool: string): string => {
    const explicit = typeof payload.callId === 'string' ? payload.callId : undefined;
    if (explicit) return explicit;
    return `legacy-${legacySeq++}-${tool}`;
  };

  const pushOpenToolBlock = (entry: OpenTool) => {
    out.push({
      kind: 'tool',
      callId: entry.callId,
      tool: entry.tool,
      status: entry.status,
      summary: summarizeToolCall(entry.tool, entry.input),
      ...(entry.input !== undefined ? { input: entry.input } : {}),
      ...(entry.output !== undefined ? { output: entry.output } : {}),
    });
  };

  for (const event of events) {
    const payload = event.payload ?? {};

    if (event.type === 'user_message') {
      flushAssistant();
      flushThinking();
      const rawText = String(payload.text ?? '');
      if (isCursorContextMessage(rawText)) {
        const parsed = parseCursorContextMessage(rawText);
        out.push({
          kind: 'cursor-context',
          summary: parsed.summary,
          instruction: parsed.instruction,
          sections: parsed.sections,
        });
      } else {
        out.push({ kind: 'user', text: rawText });
      }
      continue;
    }

    if (event.type === 'thinking_start') {
      flushAssistant();
      thinkingOpen = true;
      thinkingId = String(payload.thinkingId ?? `thinking-${event.seq}`);
      thinkingBuf = '';
      continue;
    }

    if (event.type === 'thinking_delta') {
      thinkingOpen = true;
      if (!thinkingId) thinkingId = String(payload.thinkingId ?? `thinking-${event.seq}`);
      thinkingBuf += String(payload.delta ?? '');
      continue;
    }

    if (event.type === 'thinking_message') {
      thinkingBuf = String(payload.text ?? thinkingBuf);
      flushThinking();
      continue;
    }

    if (event.type === 'user_input_requested') {
      flushAssistant();
      flushThinking();
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
      const questions = Array.isArray(payload.questions)
        ? (payload.questions as UserInputQuestion[])
        : [];
      if (requestId && questions.length > 0) {
        out.push({
          kind: 'user_input',
          requestId,
          questions,
          ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
        });
      }
      continue;
    }

    if (event.type === 'user_input_resolved') {
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
      const resolvedBy =
        typeof payload.resolvedBy === 'string'
          ? (payload.resolvedBy as UserInputResolvedBy)
          : undefined;
      if (requestId && resolvedBy) {
        const idx = out.findIndex(
          (b) => b.kind === 'user_input' && b.requestId === requestId,
        );
        if (idx >= 0) {
          const block = out[idx];
          if (block.kind === 'user_input') {
            out[idx] = { ...block, resolvedBy };
          }
        }
      }
      continue;
    }

    if (event.type === 'tool_start') {
      flushAssistant();
      flushThinking();
      const tool = String(payload.tool ?? 'unknown');
      const callId = resolveCallId(payload, tool);
      const parsed = isInteractiveToolName(tool)
        ? parseInteractiveToolInput(payload.input)
        : undefined;
      if (parsed) {
        pendingInteractive.set(callId, {
          callId,
          requestId: callId,
          questions: parsed.questions,
          ...(parsed.title ? { title: parsed.title } : {}),
        });
        out.push({
          kind: 'user_input',
          requestId: callId,
          questions: parsed.questions,
          ...(parsed.title ? { title: parsed.title } : {}),
        });
        continue;
      }
      const entry: OpenTool = {
        callId,
        tool,
        status: 'running',
        ...(payload.input !== undefined ? { input: payload.input } : {}),
      };
      openTools.set(callId, entry);
      legacyStack.push(callId);
      pushOpenToolBlock(entry);
      continue;
    }

    if (event.type === 'tool_end') {
      const tool = String(payload.tool ?? 'unknown');
      const callId =
        typeof payload.callId === 'string'
          ? payload.callId
          : legacyStack.find((id) => openTools.get(id)?.tool === tool && openTools.get(id)?.status === 'running');
      const pending = callId ? pendingInteractive.get(callId) : undefined;
      if (pending || (callId && isInteractiveToolName(tool) && pendingInteractive.has(callId))) {
        const requestId = pending?.requestId ?? callId!;
        pendingInteractive.delete(callId!);
        const resolvedBy = payload.isError ? 'skip' : 'user';
        const idx = out.findIndex(
          (b) => b.kind === 'user_input' && b.requestId === requestId,
        );
        if (idx >= 0) {
          const block = out[idx];
          if (block.kind === 'user_input') {
            out[idx] = { ...block, resolvedBy };
          }
        } else if (pending) {
          out.push({
            kind: 'user_input',
            requestId,
            questions: pending.questions,
            resolvedBy,
            ...(pending.title ? { title: pending.title } : {}),
          });
        }
        continue;
      }
      const entry = callId ? openTools.get(callId) : undefined;
      if (entry) {
        entry.status = payload.isError ? 'error' : 'done';
        if (payload.output !== undefined) entry.output = payload.output;
        const idx = out.findIndex((b) => b.kind === 'tool' && b.callId === entry.callId);
        if (idx >= 0) {
          out[idx] = {
            kind: 'tool',
            callId: entry.callId,
            tool: entry.tool,
            status: entry.status,
            summary: summarizeToolCall(entry.tool, entry.input),
            ...(entry.input !== undefined ? { input: entry.input } : {}),
            ...(entry.output !== undefined ? { output: entry.output } : {}),
          };
        }
        openTools.delete(entry.callId);
        const stackIdx = legacyStack.indexOf(entry.callId);
        if (stackIdx >= 0) legacyStack.splice(stackIdx, 1);
      } else {
        out.push({
          kind: 'tool',
          callId: resolveCallId(payload, tool),
          tool,
          status: payload.isError ? 'error' : 'done',
          summary: summarizeToolCall(tool, payload.input),
          ...(payload.output !== undefined ? { output: payload.output } : {}),
        });
      }
      continue;
    }

    if (event.type === 'assistant_delta') {
      assistantBuf += String(payload.delta ?? '');
      continue;
    }

    if (event.type === 'assistant_message') {
      assistantBuf = String(payload.text ?? assistantBuf);
      flushAssistant();
      continue;
    }

    if (event.type === 'error') {
      flushAssistant();
      flushThinking();
      out.push({ kind: 'error', message: String(payload.message ?? 'unknown') });
    }
  }

  if (thinkingOpen || thinkingBuf) {
    flushThinking(true);
  } else if (assistantBuf) {
    flushAssistant(true);
  }

  return out;
}

export function workingIndicatorLabel(blocks: TranscriptBlock[], streaming: boolean): string {
  if (!streaming) return 'Nuncio is working…';
  if (blocks.some((b) => b.kind === 'assistant' && b.streaming)) return 'Nuncio is writing…';
  const runningTool = blocks.find((b) => b.kind === 'tool' && b.status === 'running');
  if (runningTool && runningTool.kind === 'tool') {
    return `Nuncio is using ${runningTool.tool}…`;
  }
  if (blocks.some((b) => b.kind === 'thinking' && b.streaming)) return 'Nuncio is thinking…';
  return 'Nuncio is working…';
}
