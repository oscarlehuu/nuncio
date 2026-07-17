/**
 * Debug-mode reproduction gate. When a debug agent calls `request_reproduction`
 * it pauses the run into a structured, human-in-the-loop gate: numbered steps
 * the user runs, a bounded log-capture channel, and two terminal actions —
 * Proceed (continue with the collected logs) or Mark Fixed (strip the debug
 * instrumentation). The gate is stored AS an attention item of kind
 * `reproduce-requested` (reusing the queue's durability + one-tap Home
 * surfacing); this module is the typed projection + state machine over that row.
 */

export const REPRODUCE_KIND = 'reproduce-requested';

/** Total bytes of captured log text a single gate retains. Excess is rejected. */
export const LOG_CAP_BYTES = 16_384;

/**
 * The gate state machine:
 *   requested  → open, collecting logs (the paused run waits here)
 *   proceeded  → user ran the repro; the agent resumed with the collected logs
 *   fixed      → user confirmed the fix; the agent resumed to strip instrumentation
 * Both `proceeded` and `fixed` are terminal (the attention item resolves).
 */
export type GateStatus = 'requested' | 'proceeded' | 'fixed';

/** The kind-specific detail stored in the attention item's payload. */
export interface ReproducePayload {
  ref: string;
  sessionId: string;
  steps: string[];
  logsHint: string | null;
  /** Captured log lines (paste/POST), in arrival order, capped by LOG_CAP_BYTES. */
  logs: string[];
  /** Running byte total of `logs` (kept alongside so the cap check is O(1)). */
  logBytes: number;
  status: GateStatus;
}

/** The gate as the REST/WS contract exposes it (raw logs are intentionally omitted). */
export interface ReproduceGateDto {
  /** Attention item id — the handle for logs/proceed/mark-fixed over REST. */
  id: string;
  /** Stable per-request handle (matches the emitted event's ref). */
  ref: string;
  sessionId: string;
  steps: string[];
  logsHint: string | null;
  /** The live "Logs, N entries" counter. */
  logCount: number;
  status: GateStatus;
  projectPath: string | null;
  createdAt: number;
  updatedAt: number;
}

/** What a provider's `reproduce_requested` event carries (already tool-validated). */
export interface RequestReproductionInput {
  sessionId: string;
  ref: string;
  steps: string[];
  logsHint?: string | null;
}

/**
 * The seam SessionsService calls when a provider emits a reproduce event. Kept
 * as an interface so the session layer holds a registered handler and never
 * imports ReproduceService (one-directional module edge, like the chip handler).
 */
export interface ReproduceEventHandler {
  onReproduceEvent(sessionId: string, event: { type: string; payload: unknown }): void;
}
