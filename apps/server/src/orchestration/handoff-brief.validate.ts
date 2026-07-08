import type { HandoffBrief } from './handoff-brief.types';

const MAX_BRIEF_BYTES = 8192;

/** Per-field ceilings so a single protected field can never blow the 2 KB render budget. */
const GOAL_MAX_BYTES = 500;
const VERIFY_COMMAND_MAX_BYTES = 300;
const LIST_CAPS = {
  constraints: { maxItems: 20, maxItemBytes: 300 },
  decisions: { maxItems: 20, maxItemBytes: 300 },
  files: { maxItems: 20, maxItemBytes: 300 },
  doneCriteria: { maxItems: 10, maxItemBytes: 200 },
} as const;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

/** Reject a malformed workspace snapshot at the boundary (see also the renderer, which skips it silently). */
function validateWorkspace(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('contextBrief.workspace must be an object');
  }
  const ws = value as Record<string, unknown>;
  for (const field of ['branch', 'headSha', 'baseBranch', 'diffStat'] as const) {
    if (!isStringOrNull(ws[field])) {
      throw new Error(`contextBrief.workspace.${field} must be a string or null`);
    }
  }
  if (
    !Array.isArray(ws.dirtyFiles) ||
    ws.dirtyFiles.some((item) => typeof item !== 'string')
  ) {
    throw new Error('contextBrief.workspace.dirtyFiles must be an array of strings');
  }
}

/**
 * Validate an untrusted brief arriving over the API. Returns the brief when it
 * is well-formed, or throws with a caller-facing message. `goal` is required
 * and non-empty; list/string fields are shape- and size-checked; the workspace
 * snapshot (if present) must conform; the serialized brief stays under 8 KB.
 * Per-field byte caps guarantee the protected sections alone cannot exceed the
 * downstream 2 KB render budget.
 */
export function validateHandoffBrief(input: unknown): HandoffBrief {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('contextBrief must be an object');
  }
  const brief = input as Record<string, unknown>;

  if (typeof brief.goal !== 'string' || brief.goal.trim().length === 0) {
    throw new Error('contextBrief.goal is required and must be a non-empty string');
  }
  if (byteLength(brief.goal) > GOAL_MAX_BYTES) {
    throw new Error(`contextBrief.goal must be at most ${GOAL_MAX_BYTES} bytes`);
  }

  for (const [field, cap] of Object.entries(LIST_CAPS)) {
    const value = brief[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error(`contextBrief.${field} must be an array of strings`);
    }
    if (value.length > cap.maxItems) {
      throw new Error(`contextBrief.${field} must have at most ${cap.maxItems} items`);
    }
    if ((value as string[]).some((item) => byteLength(item) > cap.maxItemBytes)) {
      throw new Error(`contextBrief.${field} items must be at most ${cap.maxItemBytes} bytes each`);
    }
  }

  if (brief.verifyCommand !== undefined) {
    if (typeof brief.verifyCommand !== 'string') {
      throw new Error('contextBrief.verifyCommand must be a string');
    }
    if (byteLength(brief.verifyCommand) > VERIFY_COMMAND_MAX_BYTES) {
      throw new Error(`contextBrief.verifyCommand must be at most ${VERIFY_COMMAND_MAX_BYTES} bytes`);
    }
  }

  validateWorkspace(brief.workspace);

  const bytes = byteLength(JSON.stringify(brief));
  if (bytes > MAX_BRIEF_BYTES) {
    throw new Error('contextBrief exceeds the 8KB limit');
  }

  return brief as unknown as HandoffBrief;
}
