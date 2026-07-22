import { Inject, Injectable } from '@nestjs/common';
import { CrewBuildFinalizerService } from './crew-build-finalizer.service';
import type { CrewWorkspacePort } from './crew-execution.ports';
import { CREW_WORKSPACE_PORT } from './crew-execution.ports';
import type { CrewSubmissionNotice } from './crew-runtime-tools.service';
import type { CrewRunDto } from './domain/crew.types';
import type { CrewMemberSessionDto } from './persistence/crew-members.repository';
import { CrewResultsRepository } from './persistence/crew-results.repository';

@Injectable()
export class CrewBuildRecoveryFinalizerService {
  constructor(
    private readonly results: CrewResultsRepository,
    private readonly finalizer: CrewBuildFinalizerService,
    @Inject(CREW_WORKSPACE_PORT) private readonly workspace: CrewWorkspacePort,
  ) {}

  async finalizeCrashGap(
    run: CrewRunDto, member: CrewMemberSessionDto,
  ): Promise<CrewSubmissionNotice | null> {
    const intent = this.results.listByRun(run.id).filter((item) =>
      item.memberSessionId === member.id && item.phase === 'BUILD'
      && item.result.kind === 'builder-intent'
      && item.basedOnContextRevision === run.contextRevision
      && item.result.basedOnWorkspaceHead === run.workspaceHead,
    ).at(-1);
    if (!intent || intent.result.kind !== 'builder-intent') return null;
    const finalized = this.results.findIdempotent(run.id, `build-final:${intent.id}`);
    if (finalized?.result.kind === 'builder') {
      return this.finalizer.finalizeSettled(run.id, member.id);
    }
    if (!run.worktreePath || !run.workspaceHead) return null;
    const boundary = await this.workspace.inspectBoundary(run.worktreePath, {
      expectedBranch: run.branch ?? undefined, expectedCanonicalPath: run.worktreePath,
      expectedAncestorHead: run.workspaceHead,
    });
    const checkpointed = boundary.ok && boundary.exists && !boundary.symlink && boundary.clean
      && boundary.reachable && boundary.canonicalPath === run.worktreePath
      && boundary.branch === run.branch && boundary.fullHead !== run.workspaceHead;
    return checkpointed ? this.finalizer.finalizeSettled(run.id, member.id) : null;
  }
}
