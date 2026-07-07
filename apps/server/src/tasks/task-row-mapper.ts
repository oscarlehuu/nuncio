import type { ModelOptionsMap } from '../models/model-options.types';
import type { TaskDto, TaskRow } from './tasks.types';

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
