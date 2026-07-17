export const DEFAULT_PAYLOAD_MAX_BYTES = 4096;

import type { WorkspaceSnapshot } from '../../orchestration/workspace-snapshot';
import type { UserInputAnswer, UserInputQuestion } from './user-input.types';

export type SessionEventType =
  | 'user_message'
  | 'assistant_delta'
  | 'assistant_message'
  | 'tool_start'
  | 'tool_end'
  | 'thinking_start'
  | 'thinking_delta'
  | 'thinking_message'
  | 'user_input_requested'
  | 'user_input_resolved'
  | 'plan_updated'
  | 'evidence_captured'
  | 'error'
  | 'status'
  | 'transcript_refreshed'
  | 'runtime_restarted'
  | 'runtime_stalled'
  | 'verify_start'
  | 'verify_result'
  | 'verify_retry'
  | 'verify_needs_attention'
  | 'steer_reserved'
  | 'steer_message'
  | 'steer_queued'
  | 'steer_queue_cleared'
  | 'task_completed'
  | 'spawn_task_proposed'
  | 'spawn_task_dismissed'
  | 'interrupted';

export type UserInputResolvedBy = 'user' | 'timeout' | 'skip' | 'provider';

export interface UserInputRequestedPayload {
  requestId: string;
  questions: UserInputQuestion[];
  title?: string;
}

export interface UserInputResolvedPayload {
  requestId: string;
  resolvedBy: UserInputResolvedBy;
  /** Present for live responses; historical imported events may omit answers. */
  answers?: UserInputAnswer[];
}

export interface ToolStartPayload {
  callId?: string;
  tool: string;
  input?: unknown;
}

export interface ToolEndPayload {
  callId?: string;
  tool: string;
  isError?: boolean;
  output?: unknown;
}

export interface ThinkingStartPayload {
  thinkingId?: string;
}

export interface ThinkingDeltaPayload {
  thinkingId?: string;
  delta: string;
}

export interface ThinkingMessagePayload {
  thinkingId?: string;
  text: string;
}

export interface TaskCompletedPayload {
  taskId: string;
  childSessionId: string | null;
  status: 'DONE' | 'FAILED' | 'CANCELLED';
  /** Tail of the child's final assistant_message, ≤ 1024 bytes (deterministic v1). */
  outcomeSummary: string | null;
  /** Verify outcome; output tail ≤ 512 bytes. */
  verify: { passed: boolean; output?: string } | null;
  /** Child worktree snapshot at finish. */
  workspace: WorkspaceSnapshot | null;
  /** Branch the work lives on. */
  childBranch: string | null;
}

export interface EvidenceMediaRef {
  id: string;
  mimeType: 'image/png';
}

export interface EvidenceCapturedPayload {
  beforeRef?: EvidenceMediaRef;
  afterRef?: EvidenceMediaRef;
  route: string;
  viewport: { w: number; h: number };
  workspaceHead: string;
}

export interface TruncatedPayload {
  truncated: true;
  preview: string;
}

export function truncatePayload(
  value: unknown,
  maxBytes = DEFAULT_PAYLOAD_MAX_BYTES,
): { value: unknown; truncated: boolean } {
  if (value === undefined || value === null) {
    return { value, truncated: false };
  }
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength <= maxBytes) {
    return { value, truncated: false };
  }
  const preview = serialized.slice(0, maxBytes);
  return { value: { truncated: true, preview } satisfies TruncatedPayload, truncated: true };
}

export function isToolStartEvent(event: {
  type: string;
  payload: unknown;
}): event is { type: 'tool_start'; payload: ToolStartPayload } {
  return (
    event.type === 'tool_start' &&
    typeof event.payload === 'object' &&
    event.payload !== null &&
    typeof (event.payload as ToolStartPayload).tool === 'string'
  );
}

export function isToolEndEvent(event: {
  type: string;
  payload: unknown;
}): event is { type: 'tool_end'; payload: ToolEndPayload } {
  return (
    event.type === 'tool_end' &&
    typeof event.payload === 'object' &&
    event.payload !== null &&
    typeof (event.payload as ToolEndPayload).tool === 'string'
  );
}

export function isThinkingDeltaEvent(event: {
  type: string;
  payload: unknown;
}): event is { type: 'thinking_delta'; payload: ThinkingDeltaPayload } {
  return (
    event.type === 'thinking_delta' &&
    typeof event.payload === 'object' &&
    event.payload !== null &&
    typeof (event.payload as ThinkingDeltaPayload).delta === 'string'
  );
}

export function isUserInputRequestedEvent(event: {
  type: string;
  payload: unknown;
}): event is { type: 'user_input_requested'; payload: UserInputRequestedPayload } {
  return (
    event.type === 'user_input_requested' &&
    typeof event.payload === 'object' &&
    event.payload !== null &&
    typeof (event.payload as UserInputRequestedPayload).requestId === 'string' &&
    Array.isArray((event.payload as UserInputRequestedPayload).questions)
  );
}

export function isUserInputResolvedEvent(event: {
  type: string;
  payload: unknown;
}): event is { type: 'user_input_resolved'; payload: UserInputResolvedPayload } {
  return (
    event.type === 'user_input_resolved' &&
    typeof event.payload === 'object' &&
    event.payload !== null &&
    typeof (event.payload as UserInputResolvedPayload).requestId === 'string' &&
    typeof (event.payload as UserInputResolvedPayload).resolvedBy === 'string'
  );
}

export function isTaskCompletedEvent(event: {
  type: string;
  payload: unknown;
}): event is { type: 'task_completed'; payload: TaskCompletedPayload } {
  return (
    event.type === 'task_completed' &&
    typeof event.payload === 'object' &&
    event.payload !== null &&
    typeof (event.payload as TaskCompletedPayload).taskId === 'string' &&
    typeof (event.payload as TaskCompletedPayload).status === 'string'
  );
}

function isEvidenceRef(value: unknown): value is EvidenceMediaRef {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as Record<string, unknown>;
  return Object.keys(ref).length === 2
    && typeof ref.id === 'string'
    && /^[a-f0-9]{32}$/.test(ref.id)
    && ref.mimeType === 'image/png';
}

export function isEvidenceCapturedEvent(event: {
  type: string;
  payload: unknown;
}): event is { type: 'evidence_captured'; payload: EvidenceCapturedPayload } {
  if (event.type !== 'evidence_captured' || typeof event.payload !== 'object' || event.payload === null) {
    return false;
  }
  const payload = event.payload as Record<string, unknown>;
  const viewport = payload.viewport as Record<string, unknown> | undefined;
  const before = payload.beforeRef;
  const after = payload.afterRef;
  return (before === undefined || isEvidenceRef(before))
    && (after === undefined || isEvidenceRef(after))
    && (isEvidenceRef(before) !== isEvidenceRef(after))
    && typeof payload.route === 'string'
    && typeof payload.workspaceHead === 'string'
    && Boolean(payload.workspaceHead)
    && typeof viewport?.w === 'number'
    && Number.isInteger(viewport.w)
    && viewport.w > 0
    && typeof viewport?.h === 'number'
    && Number.isInteger(viewport.h)
    && viewport.h > 0;
}
