export const CREW_RUN_PHASES = ['PLAN', 'BUILD', 'VERIFY', 'REVIEW', 'SYNTHESIZE', 'DONE'] as const;
export type CrewRunPhase = (typeof CREW_RUN_PHASES)[number];
export const CREW_RUN_STATUSES = [
  'QUEUED', 'RUNNING', 'BLOCKED_USER', 'BLOCKED_PROVIDER', 'PAUSED', 'RECOVERING', 'TERMINAL',
] as const;
export type CrewRunStatus = (typeof CREW_RUN_STATUSES)[number];
export type CrewRunOutcome = 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | null;
export type CrewBlockedReason =
  | 'material_clarification'
  | 'verify_round_cap'
  | 'review_round_cap'
  | 'provider_unavailable'
  | 'unrecoverable_failure'
  | null;
export type CrewProviderId = 'pi' | 'codex' | 'claude' | 'devin' | 'mock';
export type CrewRuntimePolicy = 'read-only' | 'workspace-write';
export type CrewRole = 'foreman' | 'builder' | 'reviewer';

export interface CrewRoleBinding {
  provider: CrewProviderId;
  model: string;
}
// Container-sandbox configuration, applied only when `sandboxBackend === 'container'`. Every field is
// optional; omission uses the backend defaults (a slim image and conservative memory/cpu/pids caps).
// The verify command runs inside this image with the workspace snapshot bind-mounted read-write,
// dependency stores read-only, and networking disabled.
export interface CrewContainerPolicy {
  image?: string;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
}
export interface CrewProfilePolicy {
  maxVerifyRetries: number;
  maxReviewRetries: number;
  strictFreshFinalReviewer: boolean;
  verifyCommand: string | null;
  // Additive verify-execution seam configuration. Every field is optional; when omitted the
  // consumer applies the historical default and the frozen snapshot bytes are unchanged. This is
  // how an alternate isolation backend (e.g. container-based) plugs in without touching existing
  // profiles or the reducer/authority model.
  //
  // `verificationWorkspace` selects how the disposable exact-head verification workspace is
  // prepared (default 'git-snapshot'). `sandboxBackend` selects how the verify command is confined
  // (default 'host' = Seatbelt on macOS / bubblewrap on Linux). Both names are validated against
  // the registered strategies at profile resolution.
  verificationWorkspace?: string;
  sandboxBackend?: string;
  // Verify resource limits, overridable per profile. Omission keeps the 120s timeout and 16 MiB
  // combined-output cap. The output cap accepts 1 byte..64 MiB, matching the runner's hard bound.
  verifyTimeoutMs?: number;
  verifyOutputCapBytes?: number;
  // Container-backend configuration, consumed only when `sandboxBackend === 'container'`. Ignored by
  // the default host backend, so an unrelated profile is byte-identical.
  container?: CrewContainerPolicy;
}
export interface CrewProfileDefinition {
  bindings: Record<CrewRole, CrewRoleBinding>;
  policy: CrewProfilePolicy;
}
export interface CrewProfileOverride {
  bindings?: Partial<Record<CrewRole, CrewRoleBinding>>;
  policy?: Partial<CrewProfilePolicy>;
}
export interface CrewResolvedBinding extends CrewRoleBinding {
  runtimePolicy: CrewRuntimePolicy;
}
export interface CrewProfileSnapshot {
  presetId: 'quality';
  sourceProfileId: string | null;
  sourceProfileRevision: number | null;
  resolvedAt: number;
  bindings: Record<CrewRole, CrewResolvedBinding>;
  tester: { kind: 'nuncio'; runtimePolicy: 'read-only' };
  policy: CrewProfilePolicy;
}
export interface CrewProfileDto {
  id: string;
  name: string;
  presetId: 'quality';
  definition: CrewProfileDefinition;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface CrewProviderCapability {
  provider: string;
  models: string[];
  runtimePolicies: CrewRuntimePolicy[];
  testOnly?: boolean;
}
export interface CrewProfileIssue {
  code: 'missing_binding' | 'unsupported_provider' | 'provider_unavailable' | 'model_unavailable'
    | 'runtime_policy_unsupported' | 'reviewer_not_independent' | 'verify_command_missing'
    | 'verifier_sandbox_unavailable' | 'verification_workspace_unknown' | 'sandbox_backend_unknown'
    | 'verify_limit_invalid' | 'container_image_invalid' | 'container_resource_invalid';
  role?: CrewRole;
  message: string;
}
export interface CrewProfileResolution {
  state: 'ready' | 'needs_setup';
  snapshot: CrewProfileSnapshot;
  issues: CrewProfileIssue[];
}

export interface CrewRunProjection {
  phase: CrewRunPhase;
  status: CrewRunStatus;
  outcome: CrewRunOutcome;
  blockedReason: CrewBlockedReason;
  revision: number;
  contextRevision: number;
  workspaceHead: string | null;
  verifyRetriesUsed: number;
  reviewRetriesUsed: number;
  verifyExtraRounds: number;
  reviewExtraRounds: number;
}
export interface CrewRunDto extends CrewRunProjection {
  id: string;
  taskId: string;
  priorRunId: string | null;
  profileSnapshot: CrewProfileSnapshot;
  context: Record<string, unknown>;
  projectPath: string;
  baseBranch: string | null;
  baseHead: string | null;
  worktreePath: string | null;
  branch: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface CrewRunSummaryDto {
  id: string;
  taskId: string;
  objective: string;
  phase: CrewRunPhase;
  status: CrewRunStatus;
  outcome: CrewRunOutcome;
  blockedReason: CrewBlockedReason;
  revision: number;
  workspaceHead: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface CrewTaskDto {
  id: string;
  objective: string;
  projectPath: string;
  baseBranch: string | null;
  createdAt: number;
  updatedAt: number;
}

export type CrewRunEventData =
  | { type: 'run_created' }
  | { type: 'workspace_prepared'; workspaceHead: string }
  | { type: 'plan_started' }
  | { type: 'plan_accepted' }
  | { type: 'clarification_required'; reason: string }
  | { type: 'clarification_resolved'; basedOnContextRevision: number; message?: string }
  | { type: 'builder_claimed' }
  | { type: 'builder_completed'; basedOnContextRevision: number; workspaceHead: string }
  | { type: 'verify_started'; basedOnWorkspaceHead: string }
  | { type: 'verify_passed'; basedOnWorkspaceHead: string }
  | { type: 'verify_failed'; basedOnWorkspaceHead: string }
  | { type: 'reviewer_claimed'; basedOnWorkspaceHead: string }
  | { type: 'final_review_requested'; basedOnWorkspaceHead: string }
  | { type: 'final_reviewer_claimed'; basedOnWorkspaceHead: string }
  | { type: 'review_passed'; basedOnWorkspaceHead: string }
  | { type: 'changes_requested'; basedOnWorkspaceHead: string }
  | { type: 'foreman_claimed' }
  | { type: 'synthesis_completed'; basedOnContextRevision: number; workspaceHead: string }
  | { type: 'pause_requested' }
  | { type: 'resume_requested' }
  | { type: 'provider_unavailable'; reason: string }
  | { type: 'provider_restored' }
  | { type: 'recovery_started'; reason: string }
  | { type: 'recovery_succeeded' }
  | { type: 'recovery_blocked'; reason: string }
  | { type: 'cancel_requested' }
  | { type: 'unrecoverable_failure'; reason: string }
  | { type: 'extra_round_approved'; gate: 'verify' | 'review' };

export interface CrewRunEventDto {
  runId: string;
  seq: number;
  type: CrewRunEventData['type'];
  payload: Record<string, unknown>;
  idempotencyKey: string;
  actor: string;
  contextRevision: number;
  workspaceHead: string | null;
  createdAt: number;
}
export interface ApplyCrewEventInput {
  expectedRevision: number;
  idempotencyKey: string;
  actor: string;
  event: CrewRunEventData;
  workspace?: {
    worktreePath: string; branch: string; baseBranch?: string | null; baseHead?: string | null;
  };
  contextPatch?: Record<string, unknown>;
}
