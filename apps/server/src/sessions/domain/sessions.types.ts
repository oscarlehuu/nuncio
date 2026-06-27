export type SessionStatus =
  | 'CREATED'
  | 'RUNNING'
  | 'IDLE'
  | 'PAUSED'
  | 'ARCHIVED'
  | 'ERROR';

export interface SessionRow {
  id: string;
  title: string;
  status: SessionStatus;
  provider: string;
  model: string | null;
  workspace: string | null;
  prompt: string;
  preview: string | null;
  project_path: string | null;
  base_branch: string | null;
  worktree_path: string | null;
  branch: string | null;
  created_at: number;
  updated_at: number;
}

export interface EventRow {
  id: number;
  session_id: string;
  seq: number;
  type: string;
  payload: string;
  created_at: number;
}

export interface SessionEvent {
  seq: number;
  type: string;
  payload: unknown;
  createdAt: number;
}

export interface SessionDto {
  id: string;
  title: string;
  status: SessionStatus;
  provider: string;
  model: string | null;
  workspace: string | null;
  prompt: string;
  preview: string | null;
  projectPath: string | null;
  baseBranch: string | null;
  worktreePath: string | null;
  branch: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSessionDto {
  prompt: string;
  provider?: string;
  model?: string;
  workspace?: string;
  id?: string;
  projectPath?: string;
  baseBranch?: string;
  worktreePath?: string;
  branch?: string;
}

export interface SteerSessionDto {
  message: string;
}
