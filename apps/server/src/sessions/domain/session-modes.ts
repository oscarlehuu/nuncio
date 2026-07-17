/**
 * Session modes are a session-layer construct: a mode changes how a run is
 * framed (prompt overlay) and, later, its orchestration/tool policy. Mode
 * support is capability-gated per provider (`AgentCapabilities.modes`); this
 * module owns the generic pieces every mode-capable engine reuses. Absent mode
 * = the normal agent (no overlay, no chip).
 */

export const SESSION_MODES = ['debug', 'multitask'] as const;

export type SessionMode = (typeof SESSION_MODES)[number];

export function isSessionMode(value: unknown): value is SessionMode {
  return typeof value === 'string' && (SESSION_MODES as readonly string[]).includes(value);
}

/** Coerce a stored/raw value to a known mode, or null for absent/legacy/corrupt. */
export function toSessionModeOrNull(value: unknown): SessionMode | null {
  return isSessionMode(value) ? value : null;
}

/**
 * Enforce that a requested mode is supported by the resolving provider. Absent
 * mode is always fine (normal agent). Throws a caller-facing message for an
 * unknown mode string or a mode the provider's `capabilities.modes` omits — the
 * session layer wraps this in a 4xx at the create boundary.
 */
export function assertModeSupported(
  mode: SessionMode | null | undefined,
  supported: readonly SessionMode[] | undefined,
): void {
  if (mode === null || mode === undefined) return;
  if (!isSessionMode(mode)) {
    throw new Error(`Unknown session mode "${String(mode)}"`);
  }
  if (!supported || !supported.includes(mode)) {
    throw new Error(`Session mode "${mode}" is not supported by this provider`);
  }
}

/**
 * The instrumentation sentinel. Every debug log line the agent adds carries this
 * exact comment token so cleanup is a mechanical sweep and the final-diff check
 * (D3) can grep for leftovers. Kept as a const so the overlay text and any
 * server-side check reference one source of truth. The web review panel scans
 * for this same literal.
 */
export const DEBUG_SENTINEL = '// nuncio-debug';

const DEBUG_OVERLAY = `## Debug mode
You are working as a hypothesis-first debugger. Diagnose before you fix, and
NEVER edit a fix into place before evidence confirms the cause.

1. Enumerate the plausible causes as explicit, numbered hypotheses BEFORE any
   edit — each with a rough likelihood (high / medium / low). Order them so the
   cheapest-to-discriminate come first.
2. Choose the cheapest instrumentation that would confirm or eliminate the
   leading hypotheses, and add the smallest set of log lines for it. Mark EVERY
   line you add with a \`${DEBUG_SENTINEL}\` sentinel comment so the
   instrumentation is mechanically removable later. Do not fix anything yet.
3. Once instrumentation is in place, call the \`request_reproduction\` tool with
   numbered, copy-pasteable steps for the user to reproduce the failure while
   your logs collect, then END your turn. Do not guess past the gate.
4. When the user chooses Proceed you receive the collected logs. Read them and
   state which single hypothesis the evidence confirms (or add instrumentation
   and request reproduction again if inconclusive).
5. Make the smallest fix that addresses the confirmed cause — no opportunistic
   refactors.
6. Verify: call \`request_reproduction\` again so the user re-runs it. When they
   choose Mark Fixed, perform a mechanical sweep — remove EVERY line carrying the
   \`${DEBUG_SENTINEL}\` sentinel so the final diff is instrumentation-free.`;

const MULTITASK_OVERLAY = `## Multitask mode
Approach the request as a coordinator who splits work into independent,
parallelizable subtasks. In your reply:

1. Decompose the goal into 2–5 subtasks that can each proceed on their own.
2. For each subtask give a one-line scope and the files or areas it touches.
3. Check the split for overlap — call out any shared files or ordering
   constraints so the subtasks stay independent.
4. Present this split explicitly before doing the work. Parallel execution is
   not yet wired up, so lay out the plan clearly for the user to launch.`;

/**
 * The per-mode system-prompt overlay a mode-capable engine injects through its
 * own prompt seam. Empty string for the normal agent (no mode).
 */
export function modeOverlay(mode: SessionMode | null | undefined): string {
  if (mode === null || mode === undefined) return '';
  switch (mode) {
    case 'debug':
      return DEBUG_OVERLAY;
    case 'multitask':
      return MULTITASK_OVERLAY;
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}
