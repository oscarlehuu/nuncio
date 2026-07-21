export interface ProjectDto {
  id: string;
  name: string;
  path: string;
  isGit: true;
}

export interface BranchDto {
  name: string;
  isDefault: boolean;
  isCurrent: boolean;
}

/** Options for {@link GitService.listBranches}. `now` is a test seam for TTL. */
export interface ListBranchesOptions {
  refresh?: boolean;
  now?: number;
}

export interface WorktreeResult {
  worktreePath: string;
  branch: string;
  baseBranch: string;
}

export interface GitFileChange {
  path: string;
  index: string;
  workTree: string;
  staged: boolean;
  insertions: number;
  deletions: number;
}

export interface GitStatusDto {
  branch: string;
  ahead: number;
  behind: number;
  clean: boolean;
  files: GitFileChange[];
}

/** One commit in an unpushed / outgoing range. */
export interface GitCommitDto {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authoredAt: string;
}

/**
 * Commits on the current branch that have not reached the comparison base
 * (configured upstream → origin/<branch> → optional fallbackBase).
 */
export interface GitUnpushedCommitsDto {
  branch: string;
  /** Rev used as the left side of `base..HEAD`, or null when none could be resolved. */
  base: string | null;
  commits: GitCommitDto[];
}

export interface GitBranchSyncDto {
  branch: string;
  base: string | null;
  ahead: number;
  behind: number;
  outgoing: GitCommitDto[];
  incoming: GitCommitDto[];
  conflicts: string[];
  clean: boolean;
}

export interface GitStashEntryDto {
  index: number;
  message: string;
  sha: string;
}

export interface GitBlameLineDto {
  line: number;
  sha: string;
  shortSha: string;
  authorName: string;
  authoredAt: string;
  content: string;
}

export interface GitBlameDto {
  path: string;
  lines: GitBlameLineDto[];
  truncated: boolean;
}

export interface GitHistoryCommitDto extends GitCommitDto {
  parents: string[];
}

export interface GitHistoryDto {
  branch: string;
  commits: GitHistoryCommitDto[];
}

export interface PullResultDto {
  pulled: boolean;
  fastForward: boolean;
}

export interface GitDiffDto {
  diff: string;
  truncated: boolean;
}

export interface CommitResultDto {
  sha: string;
  committed: boolean;
}

export interface PushResultDto {
  pushed: boolean;
  remoteBranch: string;
}

export interface RemoteInfoDto {
  host: string;
  owner: string;
  repo: string;
}

export type GitBoundaryFailureReason =
  | 'missing'
  | 'symlink'
  | 'not-directory'
  | 'not-git'
  | 'workspace-root-mismatch'
  | 'detached-head'
  | 'branch-mismatch'
  | 'head-diverged';

export interface GitBoundaryExpectation {
  expectedBranch?: string;
  expectedAncestorHead?: string;
  expectedCanonicalPath?: string;
}

export interface GitBoundaryInspectionDto {
  ok: boolean;
  exists: boolean;
  symlink: boolean;
  canonicalPath: string;
  branch: string | null;
  fullHead: string | null;
  clean: boolean;
  reachable: boolean;
  reason: GitBoundaryFailureReason | null;
}

export interface GitCheckpointResultDto {
  fullHead: string;
  clean: true;
  committed: boolean;
}
