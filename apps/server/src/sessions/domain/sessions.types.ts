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
  createdAt: number;
  updatedAt: number;
}

export interface CreateSessionDto {
  prompt: string;
  provider?: string;
  model?: string;
  workspace?: string;
}

export interface SteerSessionDto {
  message: string;
}
