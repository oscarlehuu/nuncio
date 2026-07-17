/**
 * Multitask decomposition contract. A multitask-mode parent turns one goal into
 * a set of INDEPENDENT subtasks (a structured-output step run against the
 * session's engine), each of which becomes its own child session. This module
 * owns the shape and the normalization/validation every engine's raw output
 * passes through, so the fan-out only ever sees a clamped, well-formed split.
 *
 * The engine produces the raw split; `normalizeDecomposition` is the boundary
 * guard: trim, drop empties, clamp to the cap, and refuse a split that cannot
 * yield the minimum independent subtasks.
 */

interface MultitaskSubtask {
  /** One-line scope of what this child owns. */
  scope: string;
  /** Self-contained prompt handed to the child session (must stand alone). */
  prompt: string;
  /** Files / areas this subtask touches — feeds the non-overlap check. */
  files?: string[];
}

export interface MultitaskDecomposition {
  /** Between MULTITASK_MIN_SUBTASKS and the resolved cap, inclusive. */
  subtasks: MultitaskSubtask[];
  /** The engine's statement of why the subtasks stay independent; '' when none. */
  nonOverlap: string;
}

/** What the engine's decompose step receives. */
export interface MultitaskDecomposeInput {
  /** The parent's goal to split. */
  goal: string;
  /** Upper bound on subtasks (already clamped by the caller). */
  maxSubtasks: number;
  /** Parent model, so a real engine can decompose on the inherited model. */
  model?: string | null;
  /** Parent workspace, for engines that inspect the tree while splitting. */
  cwd?: string | null;
}

export const MULTITASK_MIN_SUBTASKS = 2;
export const MULTITASK_MAX_SUBTASKS = 5;
export const MULTITASK_DEFAULT_CAP = 5;

/** Coerce a requested cap to the supported [MIN, MAX] range; default on garbage. */
export function clampSubtaskCap(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) return MULTITASK_DEFAULT_CAP;
  return Math.min(MULTITASK_MAX_SUBTASKS, Math.max(MULTITASK_MIN_SUBTASKS, Math.trunc(parsed)));
}

function firstLine(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/**
 * Validate + normalize an engine's raw decomposition into a fan-out-ready split.
 * Throws (caller lands the parent ERROR) when the raw output cannot yield at
 * least MULTITASK_MIN_SUBTASKS independent subtasks. Extra subtasks past the cap
 * are dropped; empty-prompt entries are dropped; a missing scope falls back to
 * the prompt's first line.
 */
export function normalizeDecomposition(
  raw: unknown,
  cap: number = MULTITASK_DEFAULT_CAP,
): MultitaskDecomposition {
  const limit = clampSubtaskCap(cap);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Multitask decomposition must be an object with a subtasks array');
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.subtasks)) {
    throw new Error('Multitask decomposition must include a subtasks array');
  }

  const subtasks: MultitaskSubtask[] = [];
  for (const entry of record.subtasks) {
    if (subtasks.length >= limit) break; // clamp to cap
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : '';
    if (!prompt) continue; // an empty prompt cannot drive a child session
    const scope =
      typeof item.scope === 'string' && item.scope.trim() ? item.scope.trim() : firstLine(prompt);
    const files = Array.isArray(item.files)
      ? item.files
          .filter((file): file is string => typeof file === 'string' && file.trim().length > 0)
          .map((file) => file.trim())
      : undefined;
    subtasks.push({ scope, prompt, ...(files && files.length ? { files } : {}) });
  }

  if (subtasks.length < MULTITASK_MIN_SUBTASKS) {
    throw new Error(
      `Multitask decomposition needs at least ${MULTITASK_MIN_SUBTASKS} independent subtasks; got ${subtasks.length}`,
    );
  }

  const nonOverlap = typeof record.nonOverlap === 'string' ? record.nonOverlap.trim() : '';
  return { subtasks, nonOverlap };
}
