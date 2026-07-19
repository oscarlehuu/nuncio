import { byteLength, truncateHeadBytes } from '../../orchestration/byte-truncate';
import type { PlanItem } from './plan.types';

/**
 * Survivors snapshot for context compaction: the pinned session state that
 * must outlive a compaction VERBATIM instead of being trusted to a summarizer
 * (Grok Build's re-injection principle; plans/260719-engine-shell-and-compaction
 * phase 04). Pure and deterministic over the durable event log — byte-identical
 * output for identical inputs, never throws on malformed payloads.
 *
 * Provider-neutral on purpose: the Pi compaction extension is the first
 * consumer, but the block is derived from shared session events only.
 */

export interface SnapshotEventLike {
  type: string;
  payload: unknown;
}

export interface SessionStateSnapshotBudgets {
  /** Per-section byte caps. */
  planBytes?: number;
  verifyBytes?: number;
  reproduceBytes?: number;
  chipsBytes?: number;
  /** Whole-block cap; lowest-priority sections drop first to honor it. */
  totalBytes?: number;
}

const DEFAULTS: Required<SessionStateSnapshotBudgets> = {
  planBytes: 1600,
  verifyBytes: 1200,
  reproduceBytes: 600,
  chipsBytes: 600,
  totalBytes: 4096,
};

const HEADER = '## Pinned session state (harness-preserved across compaction)';
const MAX_REPRO_STEPS = 5;
const MAX_OPEN_CHIPS = 3;
const HEAD_SHORT_CHARS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function latestPayload(events: SnapshotEventLike[], type: string): Record<string, unknown> | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === type && isRecord(event.payload)) return event.payload;
  }
  return null;
}

function planSection(events: SnapshotEventLike[], budget: number): string | null {
  const payload = latestPayload(events, 'plan_updated');
  const items = payload && Array.isArray(payload.items) ? (payload.items as PlanItem[]) : null;
  if (!items?.length) return null;
  const lines: string[] = ['Plan:'];
  for (const item of items) {
    const text = str(isRecord(item) ? item.text : null);
    if (!text) continue;
    const box = item.status === 'done' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]';
    lines.push(`- ${box} ${text}`);
  }
  return lines.length > 1 ? truncateHeadBytes(lines.join('\n'), budget) : null;
}

function verifySection(events: SnapshotEventLike[], budget: number): string | null {
  const payload = latestPayload(events, 'verify_result');
  if (!payload || typeof payload.ok !== 'boolean') return null;
  const command = str(payload.command) ?? '(verify command)';
  if (payload.ok) {
    const head = str(payload.head);
    const headNote = head ? ` (head ${head.slice(0, HEAD_SHORT_CHARS)})` : '';
    return truncateHeadBytes(`Verify: green — \`${command}\`${headNote}`, budget);
  }
  const exit = typeof payload.exitCode === 'number' ? `exit ${payload.exitCode}` : 'no exit code';
  const tail = str(payload.outputTail);
  const lines = [`Verify: FAILED (${exit}) — \`${command}\``];
  if (tail) lines.push(tail);
  return truncateHeadBytes(lines.join('\n'), budget);
}

function reproduceSection(events: SnapshotEventLike[], budget: number): string | null {
  const payload = latestPayload(events, 'reproduce_requested');
  if (!payload) return null;
  const ref = str(payload.ref);
  const steps = Array.isArray(payload.steps)
    ? payload.steps.filter((step): step is string => typeof step === 'string' && step.trim().length > 0)
    : [];
  if (!ref || steps.length === 0) return null;
  const lines = [`Reproduction gate ${ref}:`];
  steps.slice(0, MAX_REPRO_STEPS).forEach((step, index) => {
    lines.push(`${index + 1}. ${step.trim()}`);
  });
  return truncateHeadBytes(lines.join('\n'), budget);
}

function chipsSection(events: SnapshotEventLike[], budget: number): string | null {
  const dismissed = new Set<string>();
  for (const event of events) {
    if (event.type !== 'spawn_task_dismissed' || !isRecord(event.payload)) continue;
    const id = str(event.payload.id);
    if (id) dismissed.add(id);
  }
  /** Latest proposal per ref wins; unknown-ref proposals keep insertion order. */
  const open = new Map<string, { title: string; tldr: string | null }>();
  for (const event of events) {
    if (event.type !== 'spawn_task_proposed' || !isRecord(event.payload)) continue;
    const title = str(event.payload.title);
    const ref = str(event.payload.ref) ?? `untracked:${title ?? ''}`;
    if (!title || dismissed.has(ref)) continue;
    open.set(ref, { title, tldr: str(event.payload.tldr) });
  }
  if (open.size === 0) return null;
  const lines = ['Open task chips:'];
  for (const chip of [...open.values()].slice(-MAX_OPEN_CHIPS)) {
    lines.push(chip.tldr ? `- ${chip.title} — ${chip.tldr}` : `- ${chip.title}`);
  }
  return truncateHeadBytes(lines.join('\n'), budget);
}

/**
 * Build the pinned-state block. Sections are ordered (and dropped under
 * `totalBytes` pressure) lowest priority first: chips → reproduction → verify
 * → plan. Returns an empty string when nothing needs pinning.
 */
export function buildSessionStateSnapshot(
  events: SnapshotEventLike[],
  budgets: SessionStateSnapshotBudgets = {},
): string {
  const limits = { ...DEFAULTS, ...budgets };
  // Priority order high → low; the drop loop sheds from the end.
  const sections = [
    planSection(events, limits.planBytes),
    verifySection(events, limits.verifyBytes),
    reproduceSection(events, limits.reproduceBytes),
    chipsSection(events, limits.chipsBytes),
  ].filter((section): section is string => section !== null);
  if (sections.length === 0) return '';

  let kept = sections;
  let text = [HEADER, ...kept].join('\n\n');
  while (byteLength(text) > limits.totalBytes && kept.length > 1) {
    kept = kept.slice(0, -1);
    text = [HEADER, ...kept].join('\n\n');
  }
  return byteLength(text) > limits.totalBytes
    ? truncateHeadBytes(text, limits.totalBytes)
    : text;
}
