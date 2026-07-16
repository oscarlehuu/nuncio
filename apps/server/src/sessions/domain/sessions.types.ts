import type { AgentAttachment, AgentRuntimePolicy } from '../../agents/agents.types';
import type { ModelOptionsMap } from '../../models/model-options.types';
import type { HandoffBrief } from '../../orchestration/handoff-brief.types';
import type { SessionMode } from './session-modes';

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
  mode: string | null;
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
  runtime_policy_json: string | null;
  verify_owner: string;
  cursor_backend: string | null;
  cursor_chat_id: string | null;
  forge_provider: string | null;
  pull_request_url: string | null;
  pull_request_number: number | string | null;
  pull_request_state: string | null;
  forge_status: string | null;
  parent_session_id: string | null;
  origin_task_id: string | null;
  prior_session_id: string | null;
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
  /** Session mode (debug/multitask); null = normal agent. */
  mode: SessionMode | null;
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
  runtimePolicy?: AgentRuntimePolicy | null;
  verifyOwner?: SessionVerifyOwner;
  cursorBackend: 'sdk' | 'cli' | null;
  cursorChatId: string | null;
  forgeProvider?: string | null;
  pullRequestUrl?: string | null;
  pullRequestNumber?: number | null;
  pullRequestState?: string | null;
  forgeStatus?: string;
  /** False when the stored provider id is not registered in this build. */
  providerAvailable?: boolean;
  supportsInteraction: boolean;
  supportsInterrupt: boolean;
  supportsSteerWhileRunning: boolean;
  supportsImages: boolean;
  /** Agent is blocked on an open user-input or approval request (RUNNING only). */
  pendingInput: boolean;
  /** Lineage: tree parent, the task that spawned this session, and linear-chain predecessor. */
  parentSessionId?: string | null;
  originTaskId?: string | null;
  priorSessionId?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Compact session reference used by the lineage endpoint. */
export interface SessionRefDto {
  id: string;
  title: string;
  status: SessionStatus;
  provider: string;
}

export interface SessionLineageDto {
  ancestors: SessionRefDto[];
  children: SessionRefDto[];
}

export type HandoffSessionDto =
  | {
      cursorChatId: string;
      piSessionPath?: never;
      workspace: string;
      title?: string;
      /** The nuncio session this handoff continues (linear chain predecessor). */
      priorSessionId?: string;
    }
  | {
      piSessionPath: string;
      cursorChatId?: never;
      workspace: string;
      title?: string;
      priorSessionId?: string;
    };

export interface CreateSessionDto {
  prompt: string;
  provider?: string;
  model?: string;
  modelOptions?: ModelOptionsMap;
  /** Session mode; validated against the provider's `capabilities.modes` at create. */
  mode?: SessionMode;
  attachments?: AgentAttachment[];
  workspace?: string;
  id?: string;
  projectPath?: string;
  baseBranch?: string;
  useWorktree?: boolean;
  /** Remote branch updated by the session push action when it differs from the local worktree branch. */
  pushBranch?: string;
  /** Existing remote-tracking branch configured before an adopted session starts. */
  upstreamBranch?: string;
  worktreePath?: string;
  branch?: string;
  forgeProvider?: string | null;
  pullRequestUrl?: string | null;
  pullRequestNumber?: number | null;
  pullRequestState?: string | null;
  forgeStatus?: string;
  providerThreadId?: string | null;
  providerActiveTurnId?: string | null;
  providerState?: Record<string, unknown> | null;
  runtimePolicy?: AgentRuntimePolicy | null;
  /** Crew owns verification for member sessions; ordinary sessions retain the Solo verifier. */
  verifyOwner?: SessionVerifyOwner;
  cursorBackend?: 'sdk' | 'cli' | null;
  cursorChatId?: string | null;
  /** Lineage: the parent session and originating task (set by the task runner, not the public API). */
  parentSessionId?: string;
  originTaskId?: string;
  /** Handoff brief to prepend to the first prompt (subagent spawn); composed with project facts. */
  contextBrief?: HandoffBrief;
}

export type SessionVerifyOwner = 'session' | 'crew';

export interface SteerSessionDto {
  message: string;
  forceResume?: boolean;
  attachments?: AgentAttachment[];
}

/** Internal generic turn API for durable runners continuing one exact session. */
export interface ContinueExistingSessionDto {
  prompt: string;
  contextBrief?: HandoffBrief;
  attachments?: AgentAttachment[];
  forceResume?: boolean;
  origin?: string;
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
