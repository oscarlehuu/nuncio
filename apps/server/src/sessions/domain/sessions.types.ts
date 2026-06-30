import type { AgentAttachment } from '../../agents/agents.types';
import type { ModelOptionsMap } from '../../models/model-options.types';

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
  model_options: string | null;
  workspace: string | null;
  prompt: string;
  preview: string | null;
  project_path: string | null;
  base_branch: string | null;
  worktree_path: string | null;
  branch: string | null;
  provider_thread_id: string | null;
  provider_active_turn_id: string | null;
  provider_state_json: string | null;
  cursor_backend: string | null;
  cursor_chat_id: string | null;
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

export type ProviderRequestDecision = 'approve' | 'deny';
export type ProviderRequestStatus = 'pending' | 'resolved';

export interface ProviderRequestInput {
  provider: string;
  method: string;
  params?: unknown;
}

export interface ProviderRequestResult {
  requestId: string;
  decision: ProviderRequestDecision;
}

export interface ProviderRequestRow {
  request_id: string;
  session_id: string;
  provider: string;
  method: string;
  params_json: string | null;
  status: string;
  decision: string | null;
  reason: string | null;
  created_at: number;
  resolved_at: number | null;
}

export interface ProviderRequestRecord {
  requestId: string;
  sessionId: string;
  provider: string;
  method: string;
  params?: unknown;
  status: ProviderRequestStatus;
  decision: ProviderRequestDecision | null;
  reason: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface SessionDto {
  id: string;
  title: string;
  status: SessionStatus;
  provider: string;
  model: string | null;
  modelOptions: ModelOptionsMap | null;
  workspace: string | null;
  prompt: string;
  preview: string | null;
  projectPath: string | null;
  baseBranch: string | null;
  worktreePath: string | null;
  branch: string | null;
  providerThreadId: string | null;
  providerActiveTurnId: string | null;
  providerState: Record<string, unknown> | null;
  cursorBackend: 'sdk' | 'cli' | null;
  cursorChatId: string | null;
  supportsInteraction: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface HandoffSessionDto {
  cursorChatId: string;
  workspace: string;
  title?: string;
}

export interface CreateSessionDto {
  prompt: string;
  provider?: string;
  model?: string;
  modelOptions?: ModelOptionsMap;
  attachments?: AgentAttachment[];
  workspace?: string;
  id?: string;
  projectPath?: string;
  baseBranch?: string;
  useWorktree?: boolean;
  worktreePath?: string;
  branch?: string;
  providerThreadId?: string | null;
  providerActiveTurnId?: string | null;
  providerState?: Record<string, unknown> | null;
  cursorBackend?: 'sdk' | 'cli' | null;
  cursorChatId?: string | null;
}

export interface SteerSessionDto {
  message: string;
  forceResume?: boolean;
  attachments?: AgentAttachment[];
}

export interface SetSessionModelDto {
  model: string;
  options?: ModelOptionsMap;
}

export interface RespondInteractionDto {
  answers: Array<{
    questionId: string;
    selectedOptionIds: string[];
    freeText?: string;
  }>;
  resolvedBy: 'user' | 'skip';
}

export interface RespondProviderRequestDto {
  decision: ProviderRequestDecision;
}
