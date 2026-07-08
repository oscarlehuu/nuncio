import type { SessionEvent } from './api';
import type { ProviderRequestDecision } from './api';
import type { TranscriptImage } from './attachments';
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
  | { kind: 'user'; key: string; text: string; queued?: boolean; images?: TranscriptImage[] }
  | { kind: 'assistant'; key: string; text: string; streaming?: boolean }
  | {
      kind: 'tool';
      key: string;
      callId: string;
      tool: string;
      status: 'running' | 'done' | 'error';
      input?: unknown;
      output?: unknown;
      summary: ToolSummary;
    }
  | {
      kind: 'thinking';
      key: string;
      thinkingId: string;
      text: string;
      streaming?: boolean;
      collapsedDefault: true;
    }
  | {
      kind: 'cursor-context';
      key: string;
      summary: string;
      instruction: string;
      sections: CursorContextSection[];
    }
  | {
      kind: 'user_input';
      key: string;
      requestId: string;
      title?: string;
      questions: UserInputQuestion[];
      resolvedBy?: UserInputResolvedBy;
    }
  | {
      kind: 'provider_request';
      key: string;
      requestId: string;
      provider: string;
      method: string;
      params?: unknown;
      status: 'pending' | 'resolved';
      decision?: ProviderRequestDecision;
    }
  | { kind: 'interrupted'; key: string }
  | { kind: 'task_completed'; key: string; digest: TaskDigest }
  | { kind: 'error'; key: string; message: string };

/**
 * Pure projection of a `task_completed` event payload — the digest a parent
 * session shows when a delegated subagent finishes. Everything the digest card
 * renders is derived here so the component stays presentational and the shape
 * is table-testable without React. Field-by-field defensive: persisted payloads
 * (older rows, hand-edited JSON) may be partial, and a digest must never throw.
 */
export interface TaskDigest {
  taskId: string;
  childSessionId: string | null;
  status: 'DONE' | 'FAILED' | 'CANCELLED';
  outcomeSummary: string | null;
  verify: { passed: boolean; output?: string } | null;
  childBranch: string | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function projectVerify(value: unknown): TaskDigest['verify'] {
  if (!value || typeof value !== 'object') return null;
  const passed = (value as { passed?: unknown }).passed;
  if (typeof passed !== 'boolean') return null;
  const output = str((value as { output?: unknown }).output);
  return output ? { passed, output } : { passed };
}

/** Project a raw digest payload into the card's UI data. */
export function projectTaskDigest(payload: Record<string, unknown>): TaskDigest {
  const rawStatus = payload.status;
  const status: TaskDigest['status'] =
    rawStatus === 'DONE' || rawStatus === 'CANCELLED' ? rawStatus : 'FAILED';
  return {
    taskId: str(payload.taskId) ?? '',
    childSessionId: str(payload.childSessionId),
    status,
    outcomeSummary: str(payload.outcomeSummary),
    verify: projectVerify(payload.verify),
    childBranch: str(payload.childBranch),
  };
}

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

export interface ParserState {
  out: TranscriptBlock[];
  assistantBuf: string;
  thinkingBuf: string;
  thinkingOpen: boolean;
  thinkingId: string;
  currentTurnHasThinking: boolean;
  assistantBufFromDelta: boolean;
  openTools: Map<string, OpenTool>;
  pendingInteractive: Map<string, PendingInteractive>;
  providerRequests: Map<string, Extract<TranscriptBlock, { kind: 'provider_request' }>>;
  legacyStack: string[];
  legacySeq: number;
  /** seq of the event currently being stepped — key source for point blocks. */
  lastSeq: number;
  /** seq of the first delta of the open assistant buffer — keeps the block key
   * stable from the first streamed token through the final flush. */
  assistantStartSeq: number | null;
  /** Same for the open thinking buffer. */
  thinkingStartSeq: number | null;
}

export function createParserState(): ParserState {
  return {
    out: [],
    assistantBuf: '',
    thinkingBuf: '',
    thinkingOpen: false,
    thinkingId: '',
    currentTurnHasThinking: false,
    assistantBufFromDelta: false,
    openTools: new Map(),
    pendingInteractive: new Map(),
    providerRequests: new Map(),
    legacyStack: [],
    legacySeq: 0,
    lastSeq: 0,
    assistantStartSeq: null,
    thinkingStartSeq: null,
  };
}

function flushAssistant(state: ParserState, streaming = false) {
  const cleaned = stripRedacted(state.assistantBuf);
  if (!cleaned && !streaming) return;
  const shouldSplitImportedThinking = !streaming && !state.currentTurnHasThinking && !state.assistantBufFromDelta;
  const { response, thinking } = shouldSplitImportedThinking
    ? splitThinking(cleaned || state.assistantBuf)
    : { response: cleaned || state.assistantBuf, thinking: null };
  const lastBlock = state.out[state.out.length - 1];
  const repeatsLastAssistant =
    !streaming &&
    lastBlock?.kind === 'assistant' &&
    lastBlock.text.trim() === response.trim();
  if ((response || streaming) && !repeatsLastAssistant) {
    state.out.push({
      kind: 'assistant',
      key: `assistant-${state.assistantStartSeq ?? state.lastSeq}`,
      text: response,
      ...(streaming ? { streaming: true } : {}),
    });
  }
  if (thinking) {
    state.out.push({
      kind: 'thinking',
      key: `imported-thinking-${state.lastSeq}`,
      thinkingId: 'imported-thinking',
      text: thinking,
      collapsedDefault: true,
    } as TranscriptBlock);
  }
  state.assistantBuf = '';
  state.assistantBufFromDelta = false;
  if (!streaming) state.assistantStartSeq = null;
}

function flushThinking(state: ParserState, streaming = false) {
  if (!state.thinkingOpen && !state.thinkingBuf.trim()) return;
  state.out.push({
    kind: 'thinking',
    key: `thinking-${state.thinkingStartSeq ?? state.lastSeq}`,
    thinkingId: state.thinkingId || 'thinking',
    text: state.thinkingBuf,
    collapsedDefault: true,
    ...(streaming ? { streaming: true } : {}),
  });
  state.thinkingBuf = '';
  state.thinkingOpen = false;
  state.thinkingId = '';
  if (!streaming) state.thinkingStartSeq = null;
}

function resolveCallId(
  state: ParserState,
  payload: Record<string, unknown>,
  tool: string,
): string {
  const explicit = typeof payload.callId === 'string' ? payload.callId : undefined;
  if (explicit) return explicit;
  return `legacy-${state.legacySeq++}-${tool}`;
}

function pushOpenToolBlock(state: ParserState, entry: OpenTool) {
  state.out.push({
    kind: 'tool',
    key: `tool-${entry.callId}`,
    callId: entry.callId,
    tool: entry.tool,
    status: entry.status,
    summary: summarizeToolCall(entry.tool, entry.input),
    ...(entry.input !== undefined ? { input: entry.input } : {}),
    ...(entry.output !== undefined ? { output: entry.output } : {}),
  });
}

/**
 * Applies a single event's effect onto the parser state (mutating `out` and
 * any open buffers/maps in place). This is the single source of truth for
 * per-event transcript logic — both the batch `buildTranscriptBlocks` and
 * the incremental builder in `use-transcript-blocks.ts` call this.
 */
/** Parse the untyped `images` array off a message payload into image attachments. */
function parsePayloadImages(payload: Record<string, unknown>): TranscriptImage[] | undefined {
  const raw = payload.images;
  if (!Array.isArray(raw)) return undefined;
  const images: TranscriptImage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { mimeType, id, data } = item as { mimeType?: unknown; id?: unknown; data?: unknown };
    if (typeof mimeType !== 'string') continue;
    // A disk-store reference or inline base64 — need at least one to render.
    if (typeof id === 'string') {
      images.push({ mimeType, id });
    } else if (typeof data === 'string') {
      images.push({ mimeType, data });
    }
  }
  return images.length > 0 ? images : undefined;
}

export function stepEvent(state: ParserState, event: SessionEvent): void {
  const payload = event.payload ?? {};
  state.lastSeq = event.seq;

  if (event.type === 'user_message' || event.type === 'steer_message') {
    flushAssistant(state);
    flushThinking(state);
    const rawText = String(payload.text ?? '');
    const images = parsePayloadImages(payload);
    if (isCursorContextMessage(rawText)) {
      const parsed = parseCursorContextMessage(rawText);
      state.out.push({
        kind: 'cursor-context',
        key: `ctx-${event.seq}`,
        summary: parsed.summary,
        instruction: parsed.instruction,
        sections: parsed.sections,
      });
    } else {
      // A queued steer that is now being delivered replaces its placeholder.
      for (let i = state.out.length - 1; i >= 0; i--) {
        const block = state.out[i];
        if (block.kind === 'user' && block.queued && block.text === rawText) {
          state.out.splice(i, 1);
          break;
        }
      }
      // Skip a user message that exactly repeats an already-shown one: a transcript
      // refresh re-hydrates the original prompt (image-stripped) after a run, which
      // would otherwise render as a duplicate bubble. An intentional resend of the
      // same text collapses to one — an acceptable trade for killing the duplicate.
      const alreadyShown = state.out.some(
        (block) => block.kind === 'user' && !block.queued && block.text === rawText,
      );
      if (!alreadyShown) {
        state.out.push({
          kind: 'user',
          key: `user-${event.seq}`,
          text: rawText,
          ...(images ? { images } : {}),
        });
      }
    }
    state.currentTurnHasThinking = false;
    state.assistantBufFromDelta = false;
    return;
  }

  if (event.type === 'steer_queued') {
    // Arrives mid-run: do NOT flush streaming buffers — the run keeps going.
    state.out.push({
      kind: 'user',
      key: `queued-${event.seq}`,
      text: String(payload.text ?? ''),
      queued: true,
    });
    return;
  }

  if (event.type === 'steer_queue_cleared') {
    // The queue was fanned out into parallel subagents; drop the placeholders.
    state.out = state.out.filter((block) => !(block.kind === 'user' && block.queued));
    return;
  }

  if (event.type === 'interrupted') {
    flushAssistant(state);
    flushThinking(state);
    state.out.push({ kind: 'interrupted', key: `interrupted-${event.seq}` });
    return;
  }

  if (event.type === 'task_completed') {
    flushAssistant(state);
    flushThinking(state);
    state.out.push({
      kind: 'task_completed',
      key: `task-completed-${event.seq}`,
      digest: projectTaskDigest(payload),
    });
    return;
  }

  if (event.type === 'thinking_start') {
    flushAssistant(state);
    state.thinkingOpen = true;
    state.currentTurnHasThinking = true;
    state.thinkingId = String(payload.thinkingId ?? `thinking-${event.seq}`);
    state.thinkingBuf = '';
    state.thinkingStartSeq = event.seq;
    return;
  }

  if (event.type === 'thinking_delta') {
    state.thinkingOpen = true;
    state.currentTurnHasThinking = true;
    if (!state.thinkingId) state.thinkingId = String(payload.thinkingId ?? `thinking-${event.seq}`);
    if (state.thinkingStartSeq === null) state.thinkingStartSeq = event.seq;
    state.thinkingBuf += String(payload.delta ?? '');
    return;
  }

  if (event.type === 'thinking_message') {
    state.currentTurnHasThinking = true;
    if (state.thinkingStartSeq === null) state.thinkingStartSeq = event.seq;
    state.thinkingBuf = String(payload.text ?? state.thinkingBuf);
    flushThinking(state);
    return;
  }

  if (event.type === 'user_input_requested') {
    flushAssistant(state);
    flushThinking(state);
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const questions = Array.isArray(payload.questions)
      ? (payload.questions as UserInputQuestion[])
      : [];
    if (requestId && questions.length > 0) {
      state.out.push({
        kind: 'user_input',
        key: `input-${requestId}`,
        requestId,
        questions,
        ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
      });
    }
    return;
  }

  if (event.type === 'user_input_resolved') {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const resolvedBy =
      typeof payload.resolvedBy === 'string'
        ? (payload.resolvedBy as UserInputResolvedBy)
        : undefined;
    if (requestId && resolvedBy) {
      const idx = state.out.findIndex(
        (b) => b.kind === 'user_input' && b.requestId === requestId,
      );
      if (idx >= 0) {
        const block = state.out[idx];
        if (block.kind === 'user_input') {
          state.out[idx] = { ...block, resolvedBy };
        }
      }
    }
    return;
  }

  if (event.type === 'tool_start') {
    flushAssistant(state);
    flushThinking(state);
    const tool = String(payload.tool ?? 'unknown');
    const callId = resolveCallId(state, payload, tool);
    const parsed = isInteractiveToolName(tool)
      ? parseInteractiveToolInput(payload.input)
      : undefined;
    if (parsed) {
      state.pendingInteractive.set(callId, {
        callId,
        requestId: callId,
        questions: parsed.questions,
        ...(parsed.title ? { title: parsed.title } : {}),
      });
      state.out.push({
        kind: 'user_input',
        key: `input-${callId}`,
        requestId: callId,
        questions: parsed.questions,
        ...(parsed.title ? { title: parsed.title } : {}),
      });
      return;
    }
    const entry: OpenTool = {
      callId,
      tool,
      status: 'running',
      ...(payload.input !== undefined ? { input: payload.input } : {}),
    };
    state.openTools.set(callId, entry);
    state.legacyStack.push(callId);
    pushOpenToolBlock(state, entry);
    return;
  }

  if (event.type === 'tool_end') {
    const tool = String(payload.tool ?? 'unknown');
    const callId =
      typeof payload.callId === 'string'
        ? payload.callId
        : state.legacyStack.find(
            (id) =>
              state.openTools.get(id)?.tool === tool &&
              state.openTools.get(id)?.status === 'running',
          );
    const pending = callId ? state.pendingInteractive.get(callId) : undefined;
    if (pending || (callId && isInteractiveToolName(tool) && state.pendingInteractive.has(callId))) {
      const requestId = pending?.requestId ?? callId!;
      state.pendingInteractive.delete(callId!);
      const resolvedBy = payload.isError ? 'skip' : 'user';
      const idx = state.out.findIndex(
        (b) => b.kind === 'user_input' && b.requestId === requestId,
      );
      if (idx >= 0) {
        const block = state.out[idx];
        if (block.kind === 'user_input') {
          state.out[idx] = { ...block, resolvedBy };
        }
      } else if (pending) {
        state.out.push({
          kind: 'user_input',
          key: `input-${requestId}`,
          requestId,
          questions: pending.questions,
          resolvedBy,
          ...(pending.title ? { title: pending.title } : {}),
        });
      }
      return;
    }
    const entry = callId ? state.openTools.get(callId) : undefined;
    if (entry) {
      entry.status = payload.isError ? 'error' : 'done';
      if (payload.output !== undefined) entry.output = payload.output;
      const idx = state.out.findIndex((b) => b.kind === 'tool' && b.callId === entry.callId);
      if (idx >= 0) {
        state.out[idx] = {
          kind: 'tool',
          key: `tool-${entry.callId}`,
          callId: entry.callId,
          tool: entry.tool,
          status: entry.status,
          summary: summarizeToolCall(entry.tool, entry.input),
          ...(entry.input !== undefined ? { input: entry.input } : {}),
          ...(entry.output !== undefined ? { output: entry.output } : {}),
        };
      }
      state.openTools.delete(entry.callId);
      const stackIdx = state.legacyStack.indexOf(entry.callId);
      if (stackIdx >= 0) state.legacyStack.splice(stackIdx, 1);
    } else {
      // A tool_end carrying an explicit callId but with no open tool is a stale or
      // duplicate result: re-appended by a transcript refresh, or its tool_start
      // scrolled out of a bounded event window (grid tiles subscribe to a tail).
      // Rendering an orphan tool block just floods the tile with tool rows and
      // buries the conversation, so drop it. Legacy callId-less ends (which can't
      // be correlated at all) keep their best-effort orphan block.
      if (typeof payload.callId === 'string' && payload.callId) return;
      const orphanCallId = resolveCallId(state, payload, tool);
      state.out.push({
        kind: 'tool',
        key: `tool-${orphanCallId}`,
        callId: orphanCallId,
        tool,
        status: payload.isError ? 'error' : 'done',
        summary: summarizeToolCall(tool, payload.input),
        ...(payload.output !== undefined ? { output: payload.output } : {}),
      });
    }
    return;
  }

  if (event.type === 'assistant_delta') {
    state.assistantBufFromDelta = true;
    if (state.assistantStartSeq === null) state.assistantStartSeq = event.seq;
    state.assistantBuf += String(payload.delta ?? '');
    return;
  }

  if (event.type === 'assistant_message') {
    if (state.assistantStartSeq === null) state.assistantStartSeq = event.seq;
    state.assistantBuf = String(payload.text ?? state.assistantBuf);
    flushAssistant(state);
    return;
  }

  if (event.type === 'provider_request') {
    flushAssistant(state);
    flushThinking(state);
    const request = providerRequestFromPayload(payload);
    if (request) {
      state.providerRequests.set(request.requestId, request);
      state.out.push(request);
    }
    return;
  }

  if (event.type === 'provider_request_resolved') {
    const requestId = payloadString(payload, 'requestId');
    const existing = requestId ? state.providerRequests.get(requestId) : undefined;
    const decision = providerRequestDecision(payload);
    if (existing) {
      existing.status = 'resolved';
      existing.decision = decision;
    } else if (requestId) {
      state.out.push({
        kind: 'provider_request',
        key: `pr-${requestId}`,
        requestId,
        provider: payloadString(payload, 'provider') ?? 'provider',
        method: payloadString(payload, 'method') ?? 'request',
        status: 'resolved',
        decision,
      });
    }
    return;
  }

  if (event.type === 'error') {
    flushAssistant(state);
    flushThinking(state);
    state.out.push({ kind: 'error', key: `error-${event.seq}`, message: String(payload.message ?? 'unknown') });
  }
}

/**
 * Returns the committed blocks (state.out) plus any trailing
 * streaming-tail block for unterminated assistant/thinking buffers, WITHOUT
 * mutating `state`. Safe to call repeatedly and to keep stepping events
 * afterward.
 */
export function finalizeBlocks(state: ParserState): TranscriptBlock[] {
  if (state.thinkingOpen || state.thinkingBuf) {
    const scratch: ParserState = {
      ...state,
      out: state.out.slice(),
    };
    flushThinking(scratch, true);
    return scratch.out;
  }
  if (state.assistantBuf) {
    const scratch: ParserState = {
      ...state,
      out: state.out.slice(),
    };
    flushAssistant(scratch, true);
    return scratch.out;
  }
  return state.out.slice();
}

export function buildTranscriptBlocks(events: SessionEvent[]): TranscriptBlock[] {
  const state = createParserState();
  for (const event of events) {
    stepEvent(state, event);
  }
  return finalizeBlocks(state);
}

export interface PendingQueuedSteer {
  key: string;
  text: string;
}

/**
 * The steers still waiting in the queue — surfaced in the composer's queue
 * panel rather than inline in the transcript. Derived from the same block pass
 * as the transcript, so a queued message that gets delivered (or the whole
 * queue being fanned out for multitasking) drops out of the panel in lockstep
 * with the conversation.
 */
export function derivePendingQueuedSteers(events: SessionEvent[]): PendingQueuedSteer[] {
  const pending: PendingQueuedSteer[] = [];
  for (const block of buildTranscriptBlocks(events)) {
    if (block.kind === 'user' && block.queued) {
      pending.push({ key: block.key, text: block.text });
    }
  }
  return pending;
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

function providerRequestFromPayload(
  payload: Record<string, unknown>,
): Extract<TranscriptBlock, { kind: 'provider_request' }> | null {
  const requestId = payloadString(payload, 'requestId');
  if (!requestId) return null;
  return {
    kind: 'provider_request',
    key: `pr-${requestId}`,
    requestId,
    provider: payloadString(payload, 'provider') ?? 'provider',
    method: payloadString(payload, 'method') ?? 'request',
    params: payload.params,
    status: payloadString(payload, 'status') === 'resolved' ? 'resolved' : 'pending',
    decision: providerRequestDecision(payload),
  };
}

function providerRequestDecision(
  payload: Record<string, unknown>,
): ProviderRequestDecision | undefined {
  const decision = payloadString(payload, 'decision');
  return decision === 'approve' || decision === 'deny' ? decision : undefined;
}

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}
