/** Per-project worktree policy; null/undefined = inherit the global default. */
export type WorktreePolicy = 'always' | 'never' | 'optional';

/** Tri-state per-project auto-steer override; 'inherit' defers to the global setting. */
export type VerifyAutoSteer = 'on' | 'off' | 'inherit';

/** A project CONFIG record — keyed by path, holding per-project defaults a loop consumes. */
export interface ProjectDto {
  /** Normalized absolute path — the project's identity (matches session/task project_path). */
  path: string;
  /** Display name — explicit override, else basename(path). */
  name: string;
  /** Provider-neutral default engine id, or null to inherit the global default. */
  defaultEngine: string | null;
  /** Worktree policy, or null to inherit the global default. */
  worktreePolicy: WorktreePolicy | null;
  /** Verify command override, or null to inherit .nuncio/verify → global setting. */
  verifyCommand: string | null;
  /** Per-project auto-steer override; 'inherit' (default) defers to the global setting. */
  verifyAutoSteer: VerifyAutoSteer;
  /** Per-project max auto-steer rounds, or null to inherit the global setting. */
  verifyMaxRounds: number | null;
  /**
   * Manual importance weight (rung 3) feeding attention-queue ranking + fleet
   * home. Positive integer; default 1 (equal importance) when unset.
   */
  weight: number;
  /** Default MCP servers for sessions in this project; null = inherit all scoped. */
  mcpServerIds: string[] | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Upsert-by-path input. `path` is required; every config field is optional with
 * PATCH semantics — an omitted field is left unchanged on an existing row, an
 * explicit empty string clears an override, and a new row fills omitted fields
 * with inherit-defaults (null / basename name / 'inherit').
 */
export interface UpsertProjectDto {
  path: string;
  name?: string;
  defaultEngine?: string | null;
  worktreePolicy?: WorktreePolicy | null;
  verifyCommand?: string | null;
  verifyAutoSteer?: VerifyAutoSteer;
  verifyMaxRounds?: number | null;
  /** Importance weight (rung 3). Positive integer; null/omitted keeps/uses default 1. */
  weight?: number | null;
  /** Default MCP server ids; null clears override; omit to leave unchanged. */
  mcpServerIds?: string[] | null;
}

export const WORKTREE_POLICIES: readonly WorktreePolicy[] = ['always', 'never', 'optional'];
export const VERIFY_AUTO_STEER_VALUES: readonly VerifyAutoSteer[] = ['on', 'off', 'inherit'];

export interface ProjectRow {
  path: string;
  name: string;
  default_engine: string | null;
  worktree_policy: string | null;
  verify_command: string | null;
  verify_auto_steer: string;
  verify_max_rounds: number | null;
  weight: number | null;
  mcp_server_ids_json: string | null;
  created_at: number;
  updated_at: number;
}
