import { Injectable, Optional } from '@nestjs/common';
import { CrewNotFoundError } from './domain/crew-errors';
import type { CrewRole } from './domain/crew.types';
import { CrewArtifactsRepository } from './persistence/crew-artifacts.repository';
import { CrewRunsRepository } from './persistence/crew-runs.repository';
import { CrewResultsRepository } from './persistence/crew-results.repository';
import type { CrewContextEnvelope } from './crew-context.types';
import { fitContextBudget, fitGenericBudget } from './crew-context-budget';
import {
  asBuildEvidence, asDecisions, asNullableString, asOutcome, asPlan, asPriorFailure,
  asPriorPlan, asRecords, asReviewEvidence, asString, asStrings, asUiImpact, asVerifyEvidence,
} from './crew-context-projection';

@Injectable()
export class CrewContextService {
  constructor(
    private readonly runs: CrewRunsRepository,
    private readonly artifacts: CrewArtifactsRepository,
    @Optional() private readonly results?: CrewResultsRepository,
  ) {}
  buildEnvelope(runId: string, role: CrewRole, goal: string, budget = 8192): CrewContextEnvelope {
    const run = this.runs.findById(runId);
    if (!run) throw new CrewNotFoundError('CrewRun', runId);
    const context = run.context;
    const priorFailure = asPriorFailure(context.priorFailure);
    const builderEvidence = role === 'reviewer' ? this.latestBuilderEvidence(runId, run.workspaceHead) : undefined;
    const plan = asPlan(context);
    const latestBuild = asBuildEvidence(context.lastBuild);
    const latestVerify = asVerifyEvidence(context.lastVerify);
    const latestReview = asReviewEvidence(context.lastReview);
    const priorOutcome = asOutcome(context.priorOutcome);
    const priorPlan = asPriorPlan(context.priorPlan);
    const priorGates = asRecords(context.priorGates);
    const evidence = this.artifacts.listByRun(runId).filter((artifact) => {
      if (artifact.kind !== 'workspace-diff' && artifact.kind !== 'verify-log') return true;
      return artifact.metadata.workspaceHead === run.workspaceHead;
    });
    const requiredArtifactIds = requiredEvidenceIds(role, priorFailure?.source, evidence);
    const uiImpact = role === 'reviewer' || role === 'foreman'
      ? asUiImpact(evidence.filter((artifact) => artifact.kind === 'workspace-diff').at(-1)?.metadata)
      : undefined;
    const envelope: CrewContextEnvelope = {
      kind: 'full', runId, role, contextRevision: run.contextRevision,
      objective: asString(context.objective), goal: goal.trim(),
      ...(asString(context.changeRequest) ? { changeRequest: asString(context.changeRequest) } : {}),
      ...(run.priorRunId ? { priorRun: {
        id: run.priorRunId, workspaceHead: asNullableString(context.priorWorkspaceHead),
      } } : {}),
      constraints: asStrings(context.constraints), decisions: asDecisions(context.decisions),
      doneCriteria: asStrings(context.doneCriteria), clarifications: asStrings(context.clarifications),
      workspace: { fullHead: run.workspaceHead },
      ...(priorFailure ? { priorFailure } : {}),
      ...(uiImpact ? { uiImpact } : {}),
      ...(builderEvidence ? { builderEvidence } : {}),
      ...(plan ? { plan } : {}),
      ...((role === 'reviewer' || role === 'foreman') && latestBuild ? { latestBuild } : {}),
      ...((role === 'reviewer' || role === 'foreman' || role === 'builder') && latestVerify
        ? { latestVerify } : {}),
      ...((role === 'foreman' || role === 'builder') && latestReview ? { latestReview } : {}),
      ...(priorOutcome ? { priorOutcome } : {}),
      ...(priorPlan ? { priorPlan } : {}),
      ...(priorGates.length ? { priorGates } : {}),
      artifactRefs: evidence.map((artifact) => ({
        id: artifact.id, kind: artifact.kind, byteCount: artifact.byteCount, sha256: artifact.sha256,
        ...(requiredArtifactIds.has(artifact.id) ? { required: true as const } : {}),
      })),
    };
    return fitContextBudget(envelope, budget);
  }

  buildDelta(
    runId: string, role: CrewRole, goal: string, fromContextRevision: number, budget = 4096,
  ) {
    const full = this.buildEnvelope(runId, role, goal, Math.max(8192, budget * 2));
    const delta = {
      kind: 'delta' as const, runId, role, fromContextRevision,
      contextRevision: full.contextRevision, goal: full.goal, workspace: full.workspace,
      ...(full.changeRequest ? { changeRequest: full.changeRequest } : {}),
      ...(full.priorFailure ? { priorFailure: full.priorFailure } : {}),
      ...(full.uiImpact ? { uiImpact: full.uiImpact } : {}),
      clarifications: full.clarifications.slice(-3),
      artifactRefs: full.artifactRefs,
      ...(full.builderEvidence ? { builderEvidence: full.builderEvidence } : {}),
      ...(full.plan ? { plan: full.plan } : {}),
      ...(full.latestBuild ? { latestBuild: full.latestBuild } : {}),
      ...(full.latestVerify ? { latestVerify: full.latestVerify } : {}),
      ...(full.latestReview ? { latestReview: full.latestReview } : {}),
      ...(full.priorOutcome ? { priorOutcome: full.priorOutcome } : {}),
      ...(full.priorPlan ? { priorPlan: full.priorPlan } : {}),
      ...(full.priorGates ? { priorGates: full.priorGates } : {}),
    };
    return fitGenericBudget(delta, budget);
  }

  private latestBuilderEvidence(runId: string, workspaceHead: string | null) {
    const result = this.results?.listByRun(runId)
      .filter((item) => item.result.kind === 'builder' && item.workspaceHead === workspaceHead).at(-1);
    if (!result || result.result.kind !== 'builder') return undefined;
    return {
      summary: result.result.summary, changedFiles: result.result.changedFiles,
      workspaceHead: result.result.commitHead,
    };
  }
}

function requiredEvidenceIds(
  role: CrewRole, failure: 'verify' | 'review' | undefined,
  artifacts: ReturnType<CrewArtifactsRepository['listByRun']>,
): Set<string> {
  const latest = (kind: string) => artifacts.filter((artifact) => artifact.kind === kind).at(-1);
  const required = role === 'reviewer'
    ? [latest('workspace-diff'), latest('verify-log')]
    : role === 'builder' && failure ? [latest(failure === 'verify' ? 'verify-log' : 'workspace-diff')] : [];
  if (role === 'reviewer' && required.some((artifact) => !artifact)) {
    throw new Error('Crew Reviewer deterministic evidence is incomplete');
  }
  return new Set(required.flatMap((artifact) => artifact ? [artifact.id] : []));
}
