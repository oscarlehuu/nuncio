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
