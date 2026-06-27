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
