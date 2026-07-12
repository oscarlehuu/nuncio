import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { CREW_ATTENTION_PORT, CREW_WORKSPACE_PORT, type CrewAttentionPort, type CrewWorkspacePort } from './crew-execution.ports';
import { CrewMemberService } from './crew-member.service';
import { CrewBuildRecoveryFinalizerService } from './crew-build-recovery-finalizer.service';
import { CrewProviderCatalogService } from './crew-provider-catalog.service';
import { CrewRunnerService } from './crew-runner.service';
import { redactCrewFailureReason } from './crew-runner-blocker.service';
import { CrewStageResultsService } from './crew-stage-results.service';
import { recoveryMemberForPhase, recoveryRoleForPhase, sameCrewProjection } from './crew-recovery-projection';
import { activeCrewSubmission, crewToolAuthority } from './crew-tool-authority';
import type { CrewRunDto } from './domain/crew.types';
import { CrewMembersRepository } from './persistence/crew-members.repository';
import { CrewResultsRepository } from './persistence/crew-results.repository';
import { CrewRunsRepository } from './persistence/crew-runs.repository';
import { CrewWriterLeaseService } from './crew-writer-lease.service';
@Injectable()
export class CrewRecoveryService implements OnApplicationBootstrap {
  constructor(
    private readonly database: DatabaseService,
    private readonly runs: CrewRunsRepository,
    private readonly members: CrewMembersRepository,
    private readonly results: CrewResultsRepository,
    private readonly leases: CrewWriterLeaseService,
    private readonly memberService: CrewMemberService,
    private readonly stages: CrewStageResultsService,
    private readonly buildRecovery: CrewBuildRecoveryFinalizerService,
    private readonly runner: CrewRunnerService,
    private readonly catalog: CrewProviderCatalogService,
    @Inject(CREW_WORKSPACE_PORT) private readonly workspace: CrewWorkspacePort,
    @Inject(CREW_ATTENTION_PORT) private readonly attention: CrewAttentionPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.recoverAll(false);
    this.runner.markExecutionReady();
  }

  async recoverAll(awaitDrive = true): Promise<void> {
    if (this.database.closed) return;
    await Promise.all(this.runs.list().filter((run) => run.status !== 'TERMINAL').map((run) =>
      this.recover(run.id, false, awaitDrive).catch(async (error) => {
        const current = this.requireRun(run.id);
        if (current.status === 'QUEUED' || current.status === 'RUNNING'
          || current.status === 'BLOCKED_PROVIDER' || current.status === 'RECOVERING') {
          await this.blockAndQuiesce(current, redactCrewFailureReason(error));
        } else this.raise(current, redactCrewFailureReason(error));
      }),
    ));
  }

  async retryProvider(runId: string): Promise<CrewRunDto> {
    const run = this.requireRun(runId);
    if (run.status !== 'BLOCKED_PROVIDER') throw new Error('CrewRun is not blocked on a provider');
    if (!await this.bindingAvailable(run)) {
      this.raise(run, 'Frozen Crew provider/model remains unavailable');
      return run;
    }
    return this.recover(runId, true, true);
  }

  async recover(runId: string, providerConfirmed = false, awaitDrive = true): Promise<CrewRunDto> {
    let run = this.requireRun(runId);
    if (run.status === 'TERMINAL' || run.status === 'PAUSED') return run;
    if (run.status === 'BLOCKED_USER' && run.blockedReason !== 'unrecoverable_failure') return run;
    if (!run.worktreePath) {
      if (run.phase === 'PLAN' && !run.workspaceHead) return this.drive(run, () => this.runner.start(run.id), awaitDrive);
      return this.blockAndQuiesce(run, 'Crew workspace metadata is missing');
    }
    if (run.status === 'RUNNING') {
      const replayed = await this.replayDurableResult(run);
      if (replayed.revision !== run.revision || replayed.phase !== run.phase) {
        return replayed.status === 'QUEUED'
          ? this.drive(replayed, () => this.runner.drive(run.id), awaitDrive) : replayed;
      }
    }
    run = this.requireRun(run.id);
    if (run.status === 'QUEUED') {
      await this.assertBoundary(run, run.phase !== 'BUILD');
      return this.drive(run, () => this.runner.drive(run.id), awaitDrive);
    }
    if (run.status === 'BLOCKED_PROVIDER' && !providerConfirmed && !await this.bindingAvailable(run)) {
      this.raise(run, 'Frozen Crew provider/model remains unavailable'); return run;
    }
    if (run.status !== 'RECOVERING') run = this.runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: `recovery:start:${run.revision}`,
      actor: 'nuncio:recovery', event: { type: 'recovery_started', reason: 'daemon_restart' },
    });
    try {
      const boundary = await this.assertBoundary(run, run.phase !== 'BUILD');
      const member = recoveryMemberForPhase(run, this.members);
      if (run.phase === 'BUILD') {
        const lease = this.leases.get(run.id);
        if (lease) this.leases.release(run.id, lease.token);
      }
      const role = recoveryRoleForPhase(run.phase);
      if (role && member?.sessionId && !await this.memberService.canResumeSession(member.sessionId)) {
        this.memberService.ensureMember(run.id, role, true);
      }
      run = this.runs.applyEvent(run.id, {
        expectedRevision: run.revision, idempotencyKey: `recovery:complete:${run.revision}`,
        actor: 'nuncio:recovery', event: { type: 'recovery_succeeded' },
        ...(run.phase === 'BUILD' && !boundary.clean
          ? { contextPatch: { resumeDirtyBuild: true } } : {}),
      });
      this.attention.clear('crew-blocked', run.id);
      return this.drive(run, () => this.runner.drive(run.id), awaitDrive);
    } catch (error) {
      return this.blockAndQuiesce(this.requireRun(run.id), redactCrewFailureReason(error));
    }
  }

  private async replayDurableResult(run: CrewRunDto): Promise<CrewRunDto> {
    const member = recoveryMemberForPhase(run, this.members);
    if (!member) return run;
    if (run.phase === 'BUILD') {
      const finalized = await this.buildRecovery.finalizeCrashGap(run, member);
      return finalized ? this.stages.accept(finalized) : run;
    }
    const kind = activeCrewSubmission(run, member);
    if (!kind) return run;
    const latest = this.results.findIdempotent(
      run.id, crewToolAuthority(run, member, kind).idempotencyKey,
    );
    if (!latest) return run;
    return this.stages.accept({
      runId: run.id, memberKey: member.memberKey, kind, result: latest,
      workspaceHead: latest.workspaceHead ?? run.workspaceHead!,
    });
  }

  private async assertBoundary(run: CrewRunDto, clean: boolean) {
    const replay = this.runs.replay(run.id);
    if (!sameCrewProjection(run, replay)) throw new Error('Crew stored projection does not match event replay');
    const boundary = await this.workspace.inspectBoundary(run.worktreePath!, {
      expectedBranch: run.branch ?? undefined, expectedCanonicalPath: run.worktreePath!,
    });
    if (!boundary.ok || !boundary.exists || boundary.symlink || !boundary.reachable
      || boundary.fullHead !== run.workspaceHead || (clean && !boundary.clean)) {
      throw new Error(`Crew workspace recovery boundary failed: ${boundary.reason ?? 'dirty or changed head'}`);
    }
    return boundary;
  }

  private async bindingAvailable(run: CrewRunDto): Promise<boolean> {
    const role = recoveryRoleForPhase(run.phase);
    if (!role) return true;
    const binding = run.profileSnapshot.bindings[role];
    const provider = (await this.catalog.list()).find((entry) => entry.provider === binding.provider);
    return Boolean(provider?.models.includes(binding.model)
      && provider.runtimePolicies.includes(binding.runtimePolicy));
  }

  private async drive(
    run: CrewRunDto, operation: () => Promise<CrewRunDto>, awaitDrive: boolean,
  ): Promise<CrewRunDto> {
    const pending = operation();
    if (awaitDrive) return pending;
    void pending.catch((error) => this.raise(this.requireRun(run.id), redactCrewFailureReason(error)));
    return this.requireRun(run.id);
  }

  private block(run: CrewRunDto, reason: string): CrewRunDto {
    const safeReason = redactCrewFailureReason(reason);
    let recovering = run;
    if (run.status !== 'RECOVERING') recovering = this.runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: `recovery:block-start:${run.revision}`,
      actor: 'nuncio:recovery', event: { type: 'recovery_started', reason: safeReason },
    });
    const blocked = this.runs.applyEvent(run.id, {
      expectedRevision: recovering.revision, idempotencyKey: `recovery:block:${recovering.revision}`,
      actor: 'nuncio:recovery', event: { type: 'recovery_blocked', reason: safeReason },
    });
    this.raise(blocked, safeReason); return blocked;
  }
  private async blockAndQuiesce(run: CrewRunDto, reason: string): Promise<CrewRunDto> {
    const blocked = this.block(run, reason);
    await this.runner.quiesceCrewRun(run.id);
    return blocked;
  }
  private raise(run: CrewRunDto, reason: string): void {
    const safeReason = redactCrewFailureReason(reason);
    this.attention.raise({
      kind: 'crew-blocked', subjectId: run.id, projectPath: run.projectPath,
      title: `Crew ${run.phase} recovery needs attention`,
      payload: {
        crewTaskId: run.taskId, crewRunId: run.id,
        phase: run.phase, status: run.status, reason: safeReason,
      },
    });
  }
  private requireRun(id: string): CrewRunDto {
    const run = this.runs.findById(id); if (!run) throw new Error(`CrewRun ${id} not found`); return run;
  }
}
