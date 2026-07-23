/**
 * Group sessions/tasks by repository identity so that all worktrees of one repo
 * (main checkout + linked worktrees) appear under a single project entry, with
 * each active worktree and its branch listed inside. Pure — callers resolve the
 * repo identity of each record first (see GitService.resolveRepoIdentity on the
 * server; the session DTO carries `repoIdentityId` / `repoRoot` / `isWorktree`).
 */
export interface RepoGroupSessionInput {
  id: string;
  /** Stable repo identity (RepoIdentity.id) — the grouping key. */
  identityId: string;
  /** The owning repository's main working tree, or the folder itself for non-git. */
  repoRoot: string;
  /** Display name for the project. */
  name: string;
  /** The session's branch, when known. */
  branch: string | null;
  /** The worktree path the session occupies, or null for the main checkout. */
  worktreePath: string | null;
  /** True when the session runs in a linked worktree rather than the main checkout. */
  isWorktree: boolean;
}

export interface RepoGroupWorktree {
  path: string;
  branch: string | null;
  sessionIds: string[];
}

export interface RepoGroup {
  /** Repo identity id — one entry per repository. */
  id: string;
  repoRoot: string;
  name: string;
  /** Every session that resolves to this repository, in input order. */
  sessionIds: string[];
  /** Active worktrees under this repo with their branch and occupying sessions. */
  worktrees: RepoGroupWorktree[];
}

export function groupSessionsByRepo(sessions: RepoGroupSessionInput[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  const worktreeIndex = new Map<string, Map<string, RepoGroupWorktree>>();

  for (const session of sessions) {
    let group = groups.get(session.identityId);
    if (!group) {
      group = {
        id: session.identityId,
        repoRoot: session.repoRoot,
        name: session.name,
        sessionIds: [],
        worktrees: [],
      };
      groups.set(session.identityId, group);
      worktreeIndex.set(session.identityId, new Map());
    }
    group.sessionIds.push(session.id);

    if (session.isWorktree && session.worktreePath) {
      const byPath = worktreeIndex.get(session.identityId)!;
      let worktree = byPath.get(session.worktreePath);
      if (!worktree) {
        worktree = { path: session.worktreePath, branch: session.branch, sessionIds: [] };
        byPath.set(session.worktreePath, worktree);
        group.worktrees.push(worktree);
      }
      worktree.sessionIds.push(session.id);
    }
  }

  return [...groups.values()];
}
