import { apiFetch } from './http';
import type { Session } from './api';

/**
 * Session chips (spawn-task) client. A chip is a follow-up an agent flagged
 * mid-turn on the source session; one tap spins it into its own lineage-linked
 * session. Proposed chips are open; acted/dismissed are terminal.
 */

export type ChipStatus = 'proposed' | 'acted' | 'dismissed';
export type ChipDismisser = 'user' | 'agent';

export interface ChipDto {
  /** Handle for act/dismiss over REST. */
  id: string;
  /** Stable title+prompt hash — the agent's dismiss handle. */
  ref: string;
  sourceSessionId: string;
  title: string;
  tldr: string;
  prompt: string;
  cwd: string | null;
  projectPath: string | null;
  status: ChipStatus;
  dismissedBy: ChipDismisser | null;
  dismissReason: string | null;
  /** The session created when the chip was acted, else null. */
  childSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChipActResult {
  chip: ChipDto;
  session: Session;
}

/** Open (proposed) chips for a source session — the session-view chip row. */
export async function fetchSessionChips(sessionId: string): Promise<ChipDto[]> {
  const res = await apiFetch(`/api/chips?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error('Failed to load session chips');
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as ChipDto[]) : [];
}

/** Spin the chip into a child session (inherits the source engine + model). */
export async function actChip(id: string): Promise<ChipActResult> {
  const res = await apiFetch(`/api/chips/${encodeURIComponent(id)}/act`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to spawn a session from the chip');
  return res.json();
}

/** User dismiss — terminal; the chip can no longer be spawned or re-raised. */
export async function dismissChip(id: string, reason?: string): Promise<ChipDto> {
  const res = await apiFetch(`/api/chips/${encodeURIComponent(id)}/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reason ? { reason } : {}),
  });
  if (!res.ok) throw new Error('Failed to dismiss the chip');
  return res.json();
}
