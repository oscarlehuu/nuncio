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

/** Parse NUNCIO_SUBAGENT_MODELS (JSON map of provider id → model id) leniently. */
function subagentModelForProvider(
  provider: string,
  settings?: SettingsService,
): string | undefined {
  const raw = settings?.resolve('NUNCIO_SUBAGENT_MODELS')?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>)[provider];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function buildSubagentTaskInput(
  input: StartMultitaskDto,
  parent: SessionDto,
  prompt: string,
  settings?: SettingsService,
): CreateTaskDto {
  const configuredProvider = settings?.resolve('NUNCIO_SUBAGENT_PROVIDER')?.trim();
  const provider = input.provider?.trim() || configuredProvider || parent.provider;
  // Per-provider map wins over the legacy global fallback; both are keyed by the
  // resolved provider, not the raw input.
  const mappedModel = subagentModelForProvider(provider, settings);
  const legacyModel = settings?.resolve('NUNCIO_SUBAGENT_MODEL')?.trim();
  const configuredModel = mappedModel || legacyModel;
  const model = input.model?.trim() || configuredModel || parent.model || undefined;
  // modelOptions belong to the parent's model; inherit them only when the child
  // ends up on that same model (no explicit request AND no configured override).
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
  };
}
