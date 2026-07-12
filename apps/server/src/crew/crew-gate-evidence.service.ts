import { Inject, Injectable } from '@nestjs/common';
import { CREW_WORKSPACE_PORT, type CrewWorkspacePort } from './crew-execution.ports';
import { hasBlockingReviewFinding, type CrewReviewResult } from './domain/crew-results';
import type { CrewRunDto } from './domain/crew.types';
import { CrewArtifactsRepository } from './persistence/crew-artifacts.repository';
import { CrewArtifactStore } from './crew-artifact.store';
import { CrewMembersRepository } from './persistence/crew-members.repository';
import { CrewResultsRepository } from './persistence/crew-results.repository';

export interface CrewGateEvidenceItem {
  kind: 'verify' | 'review'; status: 'running' | 'passed' | 'failed'; workspaceHead: string | null;
  warnings: string[]; artifactId: string | null;
}

@Injectable()
export class CrewGateEvidenceService {
  constructor(
    private readonly artifacts: CrewArtifactsRepository,
    private readonly store: CrewArtifactStore,
    private readonly results: CrewResultsRepository,
    private readonly members: CrewMembersRepository,
    @Inject(CREW_WORKSPACE_PORT) private readonly workspace: CrewWorkspacePort,
  ) {}

  items(run: CrewRunDto): CrewGateEvidenceItem[] {
    const verify = this.verifyArtifacts(run.id)
      .sort((a, b) => a.createdAt - b.createdAt).slice(-1)
      .map((artifact) => ({
        createdAt: artifact.createdAt,
        item: {
          kind: 'verify' as const,
          status: artifact.metadata.passed === true ? 'passed' as const : 'failed' as const,
          workspaceHead: asNullableString(artifact.metadata.workspaceHead), warnings: [],
          artifactId: artifact.id,
        },
      }));
    const finalReviewPending = run.profileSnapshot.policy.strictFreshFinalReviewer
      && isFinalReviewPending(run.context.finalReview);
    const review = this.results.listByRun(run.id)
      .filter((result) => result.result.kind === 'review')
      .sort((a, b) => a.createdAt - b.createdAt).slice(-1)
      .map((result) => {
        const value = result.result as CrewReviewResult;
        return {
          createdAt: result.createdAt,
          item: {
            kind: 'review' as const,
            status: finalReviewPending ? 'running' as const
              : hasBlockingReviewFinding(value) ? 'failed' as const : 'passed' as const,
            workspaceHead: value.workspaceHead,
            warnings: value.findings.filter((finding) => finding.severity === 'warning')
              .map(({ title, body }) => `${title}: ${body}`),
            artifactId: null,
          },
        };
      });
    return [...verify, ...review].sort((a, b) => a.createdAt - b.createdAt).map(({ item }) => item);
  }

  async assertCurrent(run: CrewRunDto): Promise<void> {
    if (!run.worktreePath || !run.workspaceHead) throw new Error('Crew workspace evidence is missing');
    const boundary = await this.workspace.inspectBoundary(run.worktreePath, {
      expectedBranch: run.branch ?? undefined,
      expectedCanonicalPath: run.worktreePath,
    });
    if (!boundary.ok || !boundary.exists || boundary.symlink || !boundary.clean || !boundary.reachable
      || boundary.canonicalPath !== run.worktreePath || boundary.branch !== run.branch
      || boundary.fullHead !== run.workspaceHead) {
      throw new Error(`Crew final workspace evidence is stale: ${boundary.reason ?? 'boundary mismatch'}`);
    }
    const latestVerify = this.verifyArtifacts(run.id).at(-1);
    if (!latestVerify || latestVerify.metadata.passed !== true
      || latestVerify.metadata.workspaceHead !== run.workspaceHead) {
      throw new Error('Crew current verify gate has not passed');
    }
    this.store.assertIntegrity(run.id, latestVerify.id);
    const latestDiff = this.artifacts.listByRun(run.id)
      .filter((artifact) => artifact.kind === 'workspace-diff').at(-1);
    if (!latestDiff || latestDiff.metadata.workspaceHead !== run.workspaceHead
      || latestDiff.metadata.baseHead !== run.baseHead || latestDiff.metadata.truncated === true) {
      throw new Error('Crew current review diff evidence is missing or truncated');
    }
    this.store.assertIntegrity(run.id, latestDiff.id);
    const latestReview = this.results.listByRun(run.id)
      .filter((result) => result.result.kind === 'review').at(-1);
    if (!latestReview || latestReview.workspaceHead !== run.workspaceHead
      || hasBlockingReviewFinding(latestReview.result as CrewReviewResult)) {
      throw new Error('Crew current review gate has not passed');
    }
    if (run.profileSnapshot.policy.strictFreshFinalReviewer && run.reviewRetriesUsed > 0) {
      const reviewer = this.members.listByRun(run.id)
        .find((member) => member.id === latestReview.memberSessionId && member.isCurrent);
      if (!reviewer?.priorMemberSessionId) throw new Error('Crew strict profile requires a fresh final reviewer');
    }
  }

  private verifyArtifacts(runId: string) {
    return this.artifacts.listByRun(runId).filter((artifact) =>
      artifact.kind === 'verify-log' && artifact.metadata.aborted !== true && !artifact.metadata.spawnError,
    );
  }
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function isFinalReviewPending(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const status = (value as Record<string, unknown>).status;
  return status === 'pending' || status === 'active';
}
