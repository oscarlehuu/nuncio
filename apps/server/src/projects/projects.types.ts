/** Per-project worktree policy; null/undefined = inherit the global default. */
export type WorktreePolicy = 'always' | 'never' | 'optional';

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
  createdAt: number;
  updatedAt: number;
}

/**
 * Upsert-by-path input. `path` is required; every config field is optional with
 * PATCH semantics — an omitted field is left unchanged on an existing row, an
 * explicit empty string clears an override, and a new row fills omitted fields
 * with inherit-defaults (null / basename name).
 */
export interface UpsertProjectDto {
  path: string;
  name?: string;
  defaultEngine?: string | null;
  worktreePolicy?: WorktreePolicy | null;
  verifyCommand?: string | null;
}
