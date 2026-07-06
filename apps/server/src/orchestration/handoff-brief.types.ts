import type { WorkspaceSnapshot } from './workspace-snapshot';

/**
 * Canonical, engine-neutral handoff brief. Travels with a delegated task and is
 * prepended to the child's first prompt as plain markdown. Engine-specific
 * wrapping (if any) is applied later by a prompt profile, never here.
 */
export interface HandoffBrief {
  /** One-sentence objective. Required. */
  goal: string;
  /** Hard constraints the child must not violate. */
  constraints?: string[];
  /** Decisions already made upstream — the child must not relitigate these. */
  decisions?: string[];
  /** Repo-relative paths the child should start from (refs, never contents). */
  files?: string[];
  /** Command that decides done. Mirrors the project verify command when unset. */
  verifyCommand?: string;
  /** Explicit done criteria, checkable by the child. */
  doneCriteria?: string[];
  /** Workspace snapshot at delegation time. */
  workspace?: WorkspaceSnapshot | null;
  /** Provenance: which session authored this brief, and at which event seq. */
  sourceSessionId?: string;
  sourceSeq?: number;
}
