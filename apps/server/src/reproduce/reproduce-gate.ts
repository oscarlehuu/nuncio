import type { AttentionItemDto } from '../attention/attention.types';
import type { GateStatus, ReproduceGateDto, ReproducePayload } from './reproduce.types';

/** Dedup key: one OPEN gate per (session, request ref). The ref keeps successive
 * debug cycles on the same session distinct, so resolving one never suppresses
 * the next (attention suppress-reraise is keyed on kind + subjectId). */
export function reproduceSubjectId(sessionId: string, ref: string): string {
  return `${sessionId}:${ref}`;
}

const STATUSES: readonly GateStatus[] = ['requested', 'proceeded', 'fixed'];

/**
 * Read the typed gate payload off an attention item, tolerating a legacy or
 * malformed shape by returning null (the caller drops it rather than throwing).
 */
function parseReproducePayload(payload: Record<string, unknown> | null): ReproducePayload | null {
  if (!payload) return null;
  const ref = str(payload.ref);
  const sessionId = str(payload.sessionId);
  const steps = strArray(payload.steps);
  if (!ref || !sessionId || steps.length === 0) return null;
  const status = STATUSES.includes(payload.status as GateStatus)
    ? (payload.status as GateStatus)
    : 'requested';
  const logs = strArray(payload.logs);
  const logBytes = typeof payload.logBytes === 'number' && payload.logBytes >= 0
    ? payload.logBytes
    : byteLen(logs);
  return {
    ref,
    sessionId,
    steps,
    logsHint: str(payload.logsHint) || null,
    logs,
    logBytes,
    status,
  };
}

/** Project an attention item into a ReproduceGateDto, or null when it is not a valid gate. */
export function gateFromAttentionItem(item: AttentionItemDto): ReproduceGateDto | null {
  const parsed = parseReproducePayload(item.payload);
  if (!parsed) return null;
  return {
    id: item.id,
    ref: parsed.ref,
    sessionId: parsed.sessionId,
    steps: parsed.steps,
    logsHint: parsed.logsHint,
    logCount: parsed.logs.length,
    status: parsed.status,
    projectPath: item.projectPath,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** The parsed payload (with raw logs) — service-internal, not exposed over REST. */
export function payloadFromAttentionItem(item: AttentionItemDto): ReproducePayload | null {
  return parseReproducePayload(item.payload);
}

function byteLen(values: string[]): number {
  const encoder = new TextEncoder();
  return values.reduce((sum, value) => sum + encoder.encode(value).byteLength, 0);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
