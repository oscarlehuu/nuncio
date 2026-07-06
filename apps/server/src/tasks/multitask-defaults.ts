import type { HandoffBrief } from '../orchestration/handoff-brief.types';
import type { SessionDto } from '../sessions/domain/sessions.types';
import type { SettingsService } from '../settings/settings.service';
import type {
  CreateTaskDto,
  StartMultitaskDto,
  TaskCleanupPolicy,
} from './tasks.types';

const CLEANUP_POLICIES: readonly TaskCleanupPolicy[] = ['after-review', 'manual', 'never'];

function cleanupPolicy(value: string | null | undefined): TaskCleanupPolicy {
  return CLEANUP_POLICIES.includes(value as TaskCleanupPolicy)
    ? (value as TaskCleanupPolicy)
    : 'after-review';
}

export function buildSubagentTaskInput(
  input: StartMultitaskDto,
  parent: SessionDto,
  prompt: string,
  settings?: SettingsService,
  brief?: HandoffBrief,
): CreateTaskDto {
  const configuredProvider = settings?.resolve('NUNCIO_SUBAGENT_PROVIDER')?.trim();
  const configuredModel = settings?.resolve('NUNCIO_SUBAGENT_MODEL')?.trim();
  const provider = input.provider?.trim() || configuredProvider || parent.provider;
  const model = input.model?.trim() || configuredModel || parent.model || undefined;
  const modelOptions =
    input.modelOptions ??
    (!input.model?.trim() && !configuredModel ? parent.modelOptions : null);
  const projectPath = input.projectPath?.trim() || parent.projectPath || undefined;
  const baseBranch = input.baseBranch?.trim() || parent.baseBranch || parent.branch || undefined;
  const useWorktree =
    input.useWorktree === true || (input.useWorktree !== false && Boolean(projectPath));
  const workspace =
    input.workspace?.trim() ||
    (useWorktree ? undefined : parent.worktreePath || parent.workspace || undefined);
  const policy = cleanupPolicy(
    input.cleanupPolicy ?? settings?.resolve('NUNCIO_SUBAGENT_CLEANUP_POLICY'),
  );

  return {
    prompt,
    provider,
    ...(model ? { model } : {}),
    ...(modelOptions ? { modelOptions } : {}),
    ...(projectPath ? { projectPath } : {}),
    ...(baseBranch ? { baseBranch } : {}),
    ...(useWorktree ? { useWorktree: true } : {}),
    ...(workspace ? { workspace } : {}),
    parentSessionId: parent.id,
    role: 'subagent',
    cleanupPolicy: policy,
    // An explicit brief on the DTO overrides the assembled one for every child.
    ...(input.contextBrief ?? brief ? { contextBrief: input.contextBrief ?? brief } : {}),
  };
}
