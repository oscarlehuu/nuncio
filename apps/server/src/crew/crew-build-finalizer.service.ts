import { Inject, Injectable } from '@nestjs/common';
import { CREW_WORKSPACE_PORT, type CrewWorkspacePort } from './crew-execution.ports';
import type { CrewBuilderIntentResult, CrewBuilderResult } from './domain/crew-results';
import type { CrewSubmissionNotice } from './crew-runtime-tools.service';
import { CrewMembersRepository } from './persistence/crew-members.repository';
import { CrewResultsRepository } from './persistence/crew-results.repository';
import { CrewRunsRepository } from './persistence/crew-runs.repository';
import { CrewWriterLeaseService } from './crew-writer-lease.service';

@Injectable()
export class CrewBuildFinalizerService {
  constructor(
    private readonly runs: CrewRunsRepository,
    private readonly members: CrewMembersRepository,
    private readonly results: CrewResultsRepository,
    private readonly leases: CrewWriterLeaseService,
    @Inject(CREW_WORKSPACE_PORT) private readonly workspace: CrewWorkspacePort,
  ) {}

  async finalizeSettled(runId: string, memberId: string): Promise<CrewSubmissionNotice> {
    const run = this.runs.findById(runId);
    const member = this.members.listByRun(runId).find((item) => item.id === memberId);
    if (!run || run.phase !== 'BUILD' || run.status === 'TERMINAL' || !run.worktreePath
      || !run.workspaceHead || !member?.isCurrent || member.memberKey !== 'builder:primary') {
      throw new Error('Crew build settlement scope is stale');
    }
    const intent = this.results.listByRun(runId).filter((item) =>
      item.memberSessionId === memberId && item.phase === 'BUILD'
      && item.result.kind === 'builder-intent'
      && item.basedOnContextRevision === run.contextRevision
      && item.result.basedOnWorkspaceHead === run.workspaceHead,
    ).at(-1);
    if (!intent || intent.result.kind !== 'builder-intent') throw new Error('Crew build has no structured intent');
    const idempotencyKey = `build-final:${intent.id}`;
    const existing = this.results.findIdempotent(runId, idempotencyKey);
    if (existing) {
      if (existing.memberSessionId !== memberId || existing.phase !== 'BUILD'
        || existing.result.kind !== 'builder'
        || existing.attempt !== intent.attempt + 1
        || existing.basedOnContextRevision !== intent.basedOnContextRevision
        || intent.result.basedOnWorkspaceHead !== run.workspaceHead
        || existing.result.basedOnWorkspaceHead !== run.workspaceHead
        || !existing.workspaceHead || existing.workspaceHead !== existing.result.commitHead) {
        throw new Error('Crew finalized build result is stale');
      }
      const lease = this.leases.get(runId);
      if (lease) {
        this.assertLease(lease, memberId, run.workspaceHead, intent.result);
        this.leases.release(runId, lease.token);
      }
      return notice(runId, member.memberKey, existing, existing.workspaceHead);
    }
    if (run.status !== 'RUNNING' && run.status !== 'RECOVERING') {
      throw new Error('Crew build settlement scope is stale');
    }
    const lease = this.leases.get(runId);
    if (!lease) throw new Error('Crew build writer lease is stale');
    const startingHead = this.assertLease(lease, memberId, run.workspaceHead, intent.result);
    const before = await this.inspect(run.worktreePath, run.branch, startingHead);
    let finalHead: string;
    if (before.fullHead === startingHead) {
      const checkpoint = await this.workspace.checkpoint(
        run.worktreePath, `chore: checkpoint Crew ${run.id} build`,
      );
      const after = await this.inspect(run.worktreePath, run.branch, startingHead);
      if (!checkpoint.clean || !after.clean || after.fullHead !== checkpoint.fullHead) {
        throw new Error('Crew build workspace changed during checkpoint');
      }
      finalHead = checkpoint.fullHead;
    } else {
      if (!before.clean) throw new Error('Crew build has a dirty descendant after checkpoint');
      finalHead = before.fullHead!;
    }
    await this.workspace.validateCheckpointRange(run.worktreePath, startingHead, finalHead);
    const result: CrewBuilderResult = finalizeIntent(intent.result, finalHead);
    const persisted = this.results.createIdempotent({
      runId, memberSessionId: memberId, phase: 'BUILD', attempt: intent.attempt + 1,
      result, basedOnContextRevision: intent.basedOnContextRevision, workspaceHead: finalHead,
    }, idempotencyKey).result;
    this.leases.release(runId, lease.token);
    return notice(runId, member.memberKey, persisted, finalHead);
  }

  private assertLease(
    lease: NonNullable<ReturnType<CrewWriterLeaseService['get']>>,
    memberId: string,
    workspaceHead: string,
    intent: CrewBuilderIntentResult,
  ): string {
    if (!lease.startingHead || lease.memberSessionId !== memberId || lease.startingHead !== workspaceHead
      || intent.basedOnWorkspaceHead !== lease.startingHead) {
      throw new Error('Crew build writer lease is stale');
    }
    return lease.startingHead;
  }

  private async inspect(path: string, branch: string | null, startingHead: string) {
    const boundary = await this.workspace.inspectBoundary(path, {
      expectedBranch: branch ?? undefined, expectedCanonicalPath: path,
      expectedAncestorHead: startingHead,
    });
    if (!boundary.ok || !boundary.exists || boundary.symlink || !boundary.reachable
      || boundary.canonicalPath !== path || boundary.branch !== branch || !boundary.fullHead) {
      throw new Error(`Crew build boundary is invalid: ${boundary.reason ?? 'mismatch'}`);
    }
    return boundary;
  }
}

function finalizeIntent(intent: CrewBuilderIntentResult, commitHead: string): CrewBuilderResult {
  return {
    kind: 'builder', summary: intent.summary, changedFiles: intent.changedFiles,
    basedOnWorkspaceHead: intent.basedOnWorkspaceHead, commitHead,
  };
}

function notice(
  runId: string, memberKey: string,
  result: ReturnType<CrewResultsRepository['create']>, workspaceHead: string,
): CrewSubmissionNotice {
  return { runId, memberKey, kind: 'build', result, workspaceHead };
}
