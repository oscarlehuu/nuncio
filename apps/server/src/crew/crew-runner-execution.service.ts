import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { CrewMemberService } from './crew-member.service';
import {
  CREW_WORKSPACE_PORT, type CrewWorkspacePort,
} from './crew-execution.ports';
import { CrewReviewEvidenceService } from './crew-review-evidence.service';
import { CrewVerifierService } from './crew-verifier.service';
import { CrewWriterLeaseService } from './crew-writer-lease.service';
import type { CrewRole, CrewRunDto } from './domain/crew.types';
import { CrewMembersRepository } from './persistence/crew-members.repository';
import { CrewRunsRepository } from './persistence/crew-runs.repository';

export class CrewProviderAttemptError extends Error {}

@Injectable()
export class CrewRunnerExecutionService {
  private destroyed = false;
  private readonly activeVerifications = new Map<string, {
    controller: AbortController; settled: Promise<void>;
  }>();

  constructor(
    private readonly database: DatabaseService,
    private readonly runs: CrewRunsRepository,
    private readonly members: CrewMembersRepository,
    private readonly memberService: CrewMemberService,
    private readonly leases: CrewWriterLeaseService,
    private readonly verifier: CrewVerifierService,
    private readonly reviewEvidence: CrewReviewEvidenceService,
    @Inject(CREW_WORKSPACE_PORT) private readonly workspace: CrewWorkspacePort,
  ) {}

  async shutdown(): Promise<void> {
    this.destroyed = true;
    const active = [...this.activeVerifications.values()];
    for (const verification of active) verification.controller.abort();
    await Promise.race([
      Promise.all(active.map((verification) => verification.settled)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }

  abortVerification(runId: string): Promise<void> {
    const active = this.activeVerifications.get(runId);
    active?.controller.abort();
    return active?.settled ?? Promise.resolve();
  }

  async prepareWorkspace(run: CrewRunDto): Promise<CrewRunDto> {
    if (!run.baseBranch || !run.baseHead) throw new Error('Crew frozen base metadata is missing');
    const created = await this.workspace.createWorktree({
      runId: run.id, projectPath: run.projectPath, baseBranch: run.baseBranch,
      baseHead: run.baseHead, slug: String(run.context.objective ?? 'crew-task'),
    });
    const boundary = await this.workspace.inspectBoundary(created.worktreePath, {
      expectedBranch: created.branch, expectedCanonicalPath: created.worktreePath,
      expectedAncestorHead: run.baseHead,
    });
    if (!boundary.ok || !boundary.exists || boundary.symlink || !boundary.clean
      || !boundary.reachable || boundary.fullHead !== run.baseHead) {
      throw new Error(boundary.reason ?? 'Crew worktree is not at the frozen base head');
    }
    return this.runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: 'runner:workspace-prepared', actor: 'nuncio',
      event: { type: 'workspace_prepared', workspaceHead: boundary.fullHead },
      workspace: {
        worktreePath: boundary.canonicalPath, branch: created.branch,
        baseBranch: created.baseBranch, baseHead: run.baseHead,
      },
    });
  }

  async startMember(
    run: CrewRunDto, role: CrewRole,
    event: Parameters<CrewRunsRepository['applyEvent']>[1]['event'], goal: string,
  ): Promise<CrewRunDto> {
    await this.assertMemberBoundary(run, role);
    const started = this.runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: `runner:${run.phase.toLowerCase()}:start:${run.revision}`,
      actor: 'nuncio', event,
      ...(role === 'builder' && run.context.resumeDirtyBuild === true
        ? { contextPatch: { resumeDirtyBuild: null } } : {}),
    });
    try {
      await this.memberService.enqueueAttempt(
        run.id, role, goal, `runner:${run.phase.toLowerCase()}:attempt:${started.revision}`,
      );
      return this.requireRun(run.id);
    } catch (error) {
      throw new CrewProviderAttemptError(reasonOf(error));
    }
  }

  async startBuilder(run: CrewRunDto): Promise<CrewRunDto> {
    await this.assertMemberBoundary(run, 'builder');
    const member = this.memberService.ensureMember(run.id, 'builder');
    if (!this.leases.get(run.id)) this.leases.acquire({
      runId: run.id, memberSessionId: member.id, memberKey: member.memberKey,
      startingHead: run.workspaceHead!,
    });
    return this.startMember(run, 'builder', { type: 'builder_claimed' },
      run.verifyRetriesUsed || run.reviewRetriesUsed ? 'Fix the latest gate feedback' : 'Build the accepted plan');
  }

  async runVerify(run: CrewRunDto): Promise<CrewRunDto> {
    const started = this.runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: `runner:verify:start:${run.revision}`, actor: 'nuncio',
      event: { type: 'verify_started', basedOnWorkspaceHead: run.workspaceHead! },
    });
    const controller = new AbortController();
    const policy = run.profileSnapshot.policy;
    const verification = this.verifier.verify({
      runId: run.id, command: policy.verifyCommand!, cwd: run.worktreePath!,
      expectedHead: run.workspaceHead!, expectedBranch: run.branch, signal: controller.signal,
      verificationWorkspace: policy.verificationWorkspace, sandboxBackend: policy.sandboxBackend,
      timeoutMs: policy.verifyTimeoutMs, outputCapBytes: policy.verifyOutputCapBytes,
    });
    const settled = verification.then(() => {}, () => {});
    this.activeVerifications.set(run.id, { controller, settled });
    let result;
    try { result = await verification; }
    finally {
      if (this.activeVerifications.get(run.id)?.controller === controller) {
        this.activeVerifications.delete(run.id);
      }
    }
    if (result.aborted) return this.requireRun(run.id);
    if (result.spawnError) throw new Error(`Crew verifier infrastructure failed: ${result.spawnError}`);
    const current = this.requireRun(run.id);
    if (this.destroyed || this.database.closed) return current;
    if (current.revision !== started.revision || current.phase !== 'VERIFY' || current.status !== 'RUNNING') return current;
    return this.runs.applyEvent(run.id, {
      expectedRevision: current.revision, idempotencyKey: `runner:verify:result:${result.artifactId}`,
      actor: 'tester:nuncio',
      event: result.passed
        ? { type: 'verify_passed', basedOnWorkspaceHead: result.workspaceHead }
        : { type: 'verify_failed', basedOnWorkspaceHead: result.workspaceHead },
      contextPatch: result.passed
        ? { lastVerify: { passed: true, artifactId: result.artifactId }, priorFailure: null }
        : { lastVerify: { passed: false, artifactId: result.artifactId },
          priorFailure: { source: 'verify', summary: result.preview.slice(0, 16_384) } },
    });
  }

  async startReview(run: CrewRunDto): Promise<CrewRunDto> {
    await this.reviewEvidence.ensureCurrentDiff(run);
    const finalReview = parseFinalReview(run.context.finalReview);
    if (!finalReview) return this.startMember(run, 'reviewer', {
      type: 'reviewer_claimed', basedOnWorkspaceHead: run.workspaceHead!,
    }, 'Review current-head deterministic diff and verify evidence');

    const member = finalReview.status === 'pending'
      ? this.memberService.ensureMember(run.id, 'reviewer', true)
      : this.memberService.ensureMember(run.id, 'reviewer');
    const started = this.runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: `runner:final-review:start:${run.revision}`,
      actor: 'nuncio', event: { type: 'final_reviewer_claimed', basedOnWorkspaceHead: run.workspaceHead! },
      contextPatch: {
        finalReview: { status: 'active', workspaceHead: run.workspaceHead, memberSessionId: member.id },
      },
    });
    try {
      await this.memberService.enqueueAttempt(
        run.id, 'reviewer', 'Perform the strict fresh final review',
        `runner:final-review:attempt:${started.revision}`,
      );
      return this.requireRun(run.id);
    } catch (error) {
      throw new CrewProviderAttemptError(reasonOf(error));
    }
  }

  private requireRun(id: string): CrewRunDto {
    const run = this.runs.findById(id); if (!run) throw new Error(`CrewRun ${id} not found`); return run;
  }
  private async assertMemberBoundary(run: CrewRunDto, role: CrewRole): Promise<void> {
    if (!run.worktreePath || !run.workspaceHead) throw new Error('Crew member workspace is not prepared');
    const boundary = await this.workspace.inspectBoundary(run.worktreePath, {
      expectedBranch: run.branch ?? undefined, expectedCanonicalPath: run.worktreePath,
    });
    const allowDirtyResume = role === 'builder' && run.context.resumeDirtyBuild === true;
    if (!boundary.ok || !boundary.exists || boundary.symlink || !boundary.reachable
      || boundary.canonicalPath !== run.worktreePath || boundary.branch !== run.branch
      || boundary.fullHead !== run.workspaceHead || (!allowDirtyResume && !boundary.clean)) {
      throw new Error(`Crew member workspace boundary is stale: ${boundary.reason ?? 'mismatch'}`);
    }
  }
}

function parseFinalReview(value: unknown): { status: 'pending' | 'active' } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = (value as Record<string, unknown>).status;
  return status === 'pending' || status === 'active' ? { status } : null;
}
function reasonOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
