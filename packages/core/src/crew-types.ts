import type { CrewMemberResultDto } from './crew-result-types';
import type { CrewArtifactDto } from './crew-artifact-types';
export type * from './crew-result-types';
export type * from './crew-artifact-types';

export type CrewRole = 'foreman' | 'builder' | 'reviewer';
export type CrewRunPhase = 'PLAN' | 'BUILD' | 'VERIFY' | 'REVIEW' | 'SYNTHESIZE' | 'DONE';
export type CrewRunStatus =
  | 'QUEUED' | 'RUNNING' | 'BLOCKED_USER' | 'BLOCKED_PROVIDER'
  | 'PAUSED' | 'RECOVERING' | 'TERMINAL';
export type CrewRunOutcome = 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | null;
export type CrewBlockReason =
  | 'material_clarification' | 'verify_round_cap' | 'review_round_cap'
  | 'provider_unavailable' | 'unrecoverable_failure' | null;

export interface CrewRoleBinding {
  provider: string;
  model: string;
  label?: string;
  runtimePolicy?: 'read-only' | 'workspace-write';
}

export interface CrewProfilePolicy {
  verifyCommand: string | null;
  maxVerifyRetries: number;
  maxReviewRetries: number;
  strictFreshFinalReviewer: boolean;
}

export interface CrewProfileDefinition {
  bindings: Record<CrewRole, CrewRoleBinding>;
  policy: CrewProfilePolicy;
}

export interface CrewProfileDto {
  id: string;
  name: string;
  revision: number;
  presetId: 'quality';
  definition: CrewProfileDefinition;
  createdAt: number;
  updatedAt: number;
}

export interface CrewProfileSnapshot extends CrewProfileDefinition {
  presetId: 'quality';
  sourceProfileId: string | null;
  sourceProfileRevision: number | null;
  tester: { kind: 'nuncio'; runtimePolicy: 'read-only' };
  resolvedAt: number;
}

export interface ResolvedCrewProfileDto {
  state: 'ready' | 'needs_setup';
  snapshot: CrewProfileSnapshot;
  issues: Array<{ code: string; role?: CrewRole; message: string }>;
}

export interface CrewTaskDto {
  id: string;
  objective: string;
  projectPath: string;
  baseBranch: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CrewRunDto {
  id: string;
  taskId: string;
  priorRunId: string | null;
  phase: CrewRunPhase;
  status: CrewRunStatus;
  outcome: CrewRunOutcome;
  blockedReason: CrewBlockReason;
  profileSnapshot: CrewProfileSnapshot;
  context: Record<string, unknown>;
  contextRevision: number;
  revision: number;
  projectPath: string;
  baseBranch: string | null;
  worktreePath: string | null;
  branch: string | null;
  workspaceHead: string | null;
  verifyRetriesUsed: number;
  reviewRetriesUsed: number;
  maxVerifyRetries: number;
  maxReviewRetries: number;
  verifyExtraRounds: number;
  reviewExtraRounds: number;
  createdAt: number;
  updatedAt: number;
}

/** Bounded list projection. Deliberately excludes profile snapshots, context, and host paths. */
export interface CrewRunSummaryDto {
  id: string;
  taskId: string;
  objective: string;
  phase: CrewRunPhase;
  status: CrewRunStatus;
  outcome: CrewRunOutcome;
  blockedReason: CrewBlockReason;
  revision: number;
  workspaceHead: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CrewMemberDto {
  id: string;
  role: CrewRole | 'tester';
  label: string;
  provider: string;
  model: string;
  sessionId: string | null;
  status: string;
}

export type CrewGateStatus =
  | 'pending' | 'running' | 'passed' | 'failed'
  | 'changes_requested' | 'blocked' | 'stale';
export interface CrewGateDto {
  kind: 'verify' | 'review';
  status: CrewGateStatus;
  workspaceHead: string | null;
  warnings: string[];
  artifactId: string | null;
}

export interface CrewRunDetailDto extends CrewRunDto {
  members: CrewMemberDto[];
  gates: CrewGateDto[];
  results: CrewMemberResultDto[];
  artifacts: CrewArtifactDto[];
}

export interface CrewEventDto {
  runId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  actor: string;
  contextRevision: number;
  workspaceHead: string | null;
  createdAt: number;
}

export interface CrewProfileInput {
  name: string;
  presetId?: 'quality';
  definition: CrewProfileDefinition;
  expectedRevision?: number;
}
export interface CreateCrewTaskInput {
  objective: string;
  projectPath: string;
  baseBranch?: string;
  profileId: string;
}
export interface CreateCrewSuccessorInput {
  changeRequest: string;
  expectedBaseHead: string;
  priorRunId: string;
  expectedRevision: number;
  profileId?: string;
}
export type CrewRunCommand = 'pause' | 'resume' | 'cancel' | 'clarification' | 'extra-round';
export type CrewRunCommandInput =
  | { expectedRevision: number }
  | { expectedRevision: number; message: string }
  | { expectedRevision: number; gate: 'verify' | 'review' };

export class CrewApiError extends Error {
  readonly status: number;
  readonly current: CrewRunDto | null;
  constructor(message: string, status: number, current: CrewRunDto | null = null) {
    super(message);
    this.status = status;
    this.current = current;
  }
}
