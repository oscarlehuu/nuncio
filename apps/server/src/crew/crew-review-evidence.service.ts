import { Inject, Injectable } from '@nestjs/common';
import { CrewArtifactStore } from './crew-artifact.store';
import { CREW_WORKSPACE_PORT, type CrewWorkspacePort } from './crew-execution.ports';
import { classifyUiImpact } from './domain/crew-ui-impact';
import type { CrewRunDto } from './domain/crew.types';
import { CrewArtifactsRepository } from './persistence/crew-artifacts.repository';

@Injectable()
export class CrewReviewEvidenceService {
  constructor(
    @Inject(CREW_WORKSPACE_PORT) private readonly workspace: CrewWorkspacePort,
    private readonly store: CrewArtifactStore,
    private readonly artifacts: CrewArtifactsRepository,
  ) {}

  async ensureCurrentDiff(run: CrewRunDto) {
    if (!run.worktreePath || !run.workspaceHead) throw new Error('Crew review workspace is not prepared');
    await this.assertBoundary(run);
    const existing = this.artifacts.listByRun(run.id).find((artifact) =>
      artifact.kind === 'workspace-diff' && artifact.metadata.workspaceHead === run.workspaceHead
      && artifact.metadata.baseHead === run.baseHead,
    );
    if (existing) {
      if (existing.metadata.truncated === true) throw new Error('Crew workspace diff exceeded the safe review artifact bound');
      return existing;
    }
    if (!run.baseHead) throw new Error('Crew review base head is missing');
    const result = await this.workspace.diff(run.worktreePath, run.baseHead);
    await this.assertBoundary(run);
    const stored = this.store.writeLog({
      runId: run.id, kind: 'workspace-diff', content: result.diff,
      metadata: {
        workspaceHead: run.workspaceHead, baseHead: run.baseHead,
        truncated: result.truncated, ...classifyUiImpact(result.diff),
      },
    });
    if (result.truncated) throw new Error('Crew workspace diff exceeded the safe review artifact bound');
    return stored.artifact;
  }

  private async assertBoundary(run: CrewRunDto): Promise<void> {
    const boundary = await this.workspace.inspectBoundary(run.worktreePath!, {
      expectedBranch: run.branch ?? undefined, expectedCanonicalPath: run.worktreePath!,
    });
    if (!boundary.ok || !boundary.exists || boundary.symlink || !boundary.clean || !boundary.reachable
      || boundary.canonicalPath !== run.worktreePath || boundary.branch !== run.branch
      || boundary.fullHead !== run.workspaceHead) {
      throw new Error(`Crew review workspace boundary is stale: ${boundary.reason ?? 'mismatch'}`);
    }
  }
}
