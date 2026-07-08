import type { ModelOptionsMap } from '../models/model-options.types';
import type { HandoffBrief } from '../orchestration/handoff-brief.types';

export type TaskStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';
export type TaskRole = 'standalone' | 'subagent';
export type TaskCleanupPolicy = 'after-review' | 'manual' | 'never';
export type TaskReviewState = 'awaiting_review' | 'reviewed';
export type NotifyPolicy = 'event-only' | 'steer';

export const NOTIFY_POLICIES: readonly NotifyPolicy[] = ['event-only', 'steer'];

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['DONE', 'FAILED', 'CANCELLED'];

export interface TaskRow {
  id: string;
  prompt: string;
  status: TaskStatus;
  provider: string | null;
  model: string | null;
  model_options: string | null;
  project_path: string | null;
  base_branch: string | null;
  use_worktree: number;
  workspace: string | null;
  parent_session_id: string | null;
  role: TaskRole;
  cleanup_policy: TaskCleanupPolicy | null;
  review_state: TaskReviewState | null;
  session_id: string | null;
  outcome_json: string | null;
  hold_until: number | null;
  context_json: string | null;
  notify_policy: string | null;
  tag: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface TaskDto {
  id: string;
  prompt: string;
  status: TaskStatus;
  provider: string | null;
  model: string | null;
  modelOptions: ModelOptionsMap | null;
  projectPath: string | null;
  baseBranch: string | null;
  useWorktree: boolean;
  workspace: string | null;
  parentSessionId: string | null;
  role: TaskRole;
  cleanupPolicy: TaskCleanupPolicy | null;
  reviewState: TaskReviewState | null;
  sessionId: string | null;
  outcome: Record<string, unknown> | null;
  contextBrief?: HandoffBrief | null;
  /** Per-task override of the delegate-notify policy; null falls back to the setting. */
  notifyPolicy?: NotifyPolicy | null;
  /** Routing tag (mechanical|review|design|research); persisted for C3, not yet routed on. */
  tag?: string | null;
  /** Derived at read time: the linked session is waiting on the user. */
  pendingInput?: boolean;
  /** When set, the pump must not claim this task until Date.now() >= holdUntil. */
  holdUntil?: number | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface CreateTaskDto {
  prompt: string;
  provider?: string;
  model?: string;
  modelOptions?: ModelOptionsMap | null;
  projectPath?: string;
  baseBranch?: string;
  useWorktree?: boolean;
  workspace?: string;
  parentSessionId?: string;
  role?: TaskRole;
  cleanupPolicy?: TaskCleanupPolicy;
  holdUntil?: number;
  contextBrief?: HandoffBrief;
  notifyPolicy?: NotifyPolicy;
  tag?: string;
}

export interface StartMultitaskDto {
  parentSessionId: string;
  prompts: string[];
  provider?: string;
  model?: string;
  modelOptions?: ModelOptionsMap | null;
  projectPath?: string;
  baseBranch?: string;
  useWorktree?: boolean;
  workspace?: string;
  cleanupPolicy?: TaskCleanupPolicy;
  /** Explicit brief overriding the deterministic assembler for every child. */
  contextBrief?: HandoffBrief;
  /** Notify-policy override applied to every child in the fan-out. */
  notifyPolicy?: NotifyPolicy;
}

export interface StartMultitaskResultDto {
  parentSessionId: string;
  tasks: TaskDto[];
}
