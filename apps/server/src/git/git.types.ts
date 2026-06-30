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
}

export interface GitFileChange {
  path: string;
  index: string;
  workTree: string;
  staged: boolean;
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
