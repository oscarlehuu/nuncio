import type { ModelOptionsMap } from '../models/model-options.types';
import type { HandoffBrief } from '../orchestration/handoff-brief.types';
import type { AgentRuntimePolicy } from '../agents/agents.types';
import type { SessionVerifyOwner } from '../sessions/domain/sessions.types';
import {
  NOTIFY_POLICIES,
  type NotifyPolicy,
  type TaskDto,
  type TaskExecutionKind,
  type TaskRow,
} from './tasks.types';

function parseNotifyPolicy(value: string | null): NotifyPolicy | null {
  return NOTIFY_POLICIES.includes(value as NotifyPolicy) ? (value as NotifyPolicy) : null;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function parseVerifyOwner(value: string): SessionVerifyOwner {
  return value === 'crew' ? 'crew' : 'session';
}

function parseExecutionKind(value: string): TaskExecutionKind {
  return value === 'crew-member' ? 'crew-member' : 'session';
}

export function taskRowToDto(row: TaskRow): TaskDto {
  return {
    id: row.id,
    prompt: row.prompt,
    status: row.status,
    provider: row.provider,
    model: row.model,
    modelOptions: parseJson<ModelOptionsMap>(row.model_options),
    projectPath: row.project_path,
    baseBranch: row.base_branch,
    useWorktree: row.use_worktree === 1,
    workspace: row.workspace,
    parentSessionId: row.parent_session_id,
    role: row.role,
    cleanupPolicy: row.cleanup_policy,
    reviewState: row.review_state,
    sessionId: row.session_id,
    outcome: parseJson<Record<string, unknown>>(row.outcome_json),
    contextBrief: parseJson<HandoffBrief>(row.context_json),
    notifyPolicy: parseNotifyPolicy(row.notify_policy),
    tag: row.tag,
    executionKind: parseExecutionKind(row.execution_kind),
    crewRunId: row.crew_run_id,
    crewMemberKey: row.crew_member_key,
    crewPhase: row.crew_phase,
    crewAttemptKey: row.crew_attempt_key,
    runtimePolicy: parseJson<AgentRuntimePolicy>(row.runtime_policy_json),
    verifyOwner: parseVerifyOwner(row.verify_owner),
    holdUntil: row.hold_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
