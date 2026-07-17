/**
 * Session chips (spawn-task). A chip is a proposed follow-up task an agent
 * flagged mid-turn, linked to the source session, that the user can spin into
 * its own session with one tap. It is stored AS an attention item of kind
 * `spawn-task` (reusing the queue's durability, dedup and Home surfacing); this
 * module is the typed projection + lifecycle over that row.
 */

export const SPAWN_TASK_KIND = 'spawn-task';

export type ChipStatus = 'proposed' | 'acted' | 'dismissed';
export type ChipDismisser = 'user' | 'agent';

/** The kind-specific detail stored in the attention item's payload. */
export interface ChipPayload {
  ref: string;
  sourceSessionId: string;
  tldr: string;
  prompt: string;
  cwd: string | null;
  status: ChipStatus;
  dismissedBy?: ChipDismisser;
  dismissReason?: string;
  childSessionId?: string;
}

/** The chip as the REST/WS contract exposes it. */
export interface ChipDto {
  /** Attention item id — the handle for act/dismiss over REST. */
  id: string;
  /** Stable title+prompt hash — the agent's dismiss_task handle. */
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

/** What the source session's agent proposed (already validated at the tool boundary). */
export interface ProposeChipInput {
  sourceSessionId: string;
  title: string;
  tldr: string;
  prompt: string;
  cwd?: string | null;
}

/**
 * The seam SessionsService calls when a provider emits a spawn-task event. Kept
 * as an interface so the session layer holds a registered handler and never
 * imports ChipsService (one-directional module edge, like the multitask
 * coordinator).
 */
export interface SpawnTaskEventHandler {
  onSpawnTaskEvent(sourceSessionId: string, event: { type: string; payload: unknown }): void;
}
