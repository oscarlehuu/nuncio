import { apiFetch } from './http';

/**
 * Debug reproduction-gate client. When a debug agent calls request_reproduction
 * the run pauses into a gate: numbered steps the user runs, a bounded log
 * counter, and two terminal actions — Proceed (continue with the collected
 * logs) or Mark Fixed (strip the debug instrumentation). Requested gates are
 * open; proceeded/fixed are terminal.
 */

export type GateStatus = 'requested' | 'proceeded' | 'fixed';

export interface ReproduceGateDto {
  /** Handle for logs/proceed/mark-fixed over REST. */
  id: string;
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

/** Open (requested) gates for a session — the session-view reproduction gate. */
export async function fetchSessionReproduceGates(sessionId: string): Promise<ReproduceGateDto[]> {
  const res = await apiFetch(`/api/reproduce?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error('Failed to load reproduction gates');
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as ReproduceGateDto[]) : [];
}

/** Append captured log lines (paste blob or explicit lines) to an open gate. */
export async function appendReproduceLogs(
  id: string,
  input: { text: string } | { lines: string[] },
): Promise<ReproduceGateDto> {
  const res = await apiFetch(`/api/reproduce/${encodeURIComponent(id)}/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('Failed to capture logs');
  return res.json();
}

/** Proceed: resume the paused run with the collected logs. */
export async function proceedReproduceGate(id: string): Promise<ReproduceGateDto> {
  const res = await apiFetch(`/api/reproduce/${encodeURIComponent(id)}/proceed`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to proceed');
  return res.json();
}

/** Mark Fixed: resume the run to strip the debug instrumentation. */
export async function markReproduceFixed(id: string): Promise<ReproduceGateDto> {
  const res = await apiFetch(`/api/reproduce/${encodeURIComponent(id)}/mark-fixed`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to mark fixed');
  return res.json();
}
