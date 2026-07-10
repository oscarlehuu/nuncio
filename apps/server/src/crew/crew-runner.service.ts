import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { TasksService } from '../tasks/tasks.service';
import type { TaskDto } from '../tasks/tasks.types';
import { CrewBuildFinalizerService } from './crew-build-finalizer.service';
import { expectedCrewAttemptKey, findCurrentCrewResult } from './crew-attempt-correlation';
import { CrewGateEvidenceService } from './crew-gate-evidence.service';
import { CrewRunnerBlockerService } from './crew-runner-blocker.service';
import { CrewRunQuiescerService } from './crew-run-quiescer.service';
import {
  CrewProviderAttemptError, CrewRunnerExecutionService,
} from './crew-runner-execution.service';
import { CrewRuntimeToolsService, type CrewSubmissionNotice } from './crew-runtime-tools.service';
import { CrewStageResultsService } from './crew-stage-results.service';
import type { CrewRunDto } from './domain/crew.types';
import { CrewMembersRepository } from './persistence/crew-members.repository';
import { CrewResultsRepository } from './persistence/crew-results.repository';
import { CrewRunsRepository } from './persistence/crew-runs.repository';

@Injectable()
export class CrewRunnerService implements OnModuleInit, OnModuleDestroy {
  private unregisterTask?: () => void;
  private destroyed = false;
  private executionReady = false;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly runs: CrewRunsRepository,
    private readonly members: CrewMembersRepository,
    private readonly results: CrewResultsRepository,
    private readonly gates: CrewGateEvidenceService,
    private readonly finalizer: CrewBuildFinalizerService,
    private readonly stages: CrewStageResultsService,
    private readonly execution: CrewRunnerExecutionService,
    private readonly quiescer: CrewRunQuiescerService,
    private readonly blocker: CrewRunnerBlockerService,
    private readonly runtimeTools: CrewRuntimeToolsService,
    private readonly tasks: TasksService,
  ) {}

  onModuleInit(): void {
    this.runtimeTools.setSubmissionSink(async (notice) => { await this.acceptSubmission(notice); });
    this.unregisterTask = this.tasks.onTaskFinished((task) => {
      if (this.executionReady && !isBootInterruptedCrewTask(task)) void this.handleTaskFinished(task);
    });
  }
  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    this.unregisterTask?.();
    this.runtimeTools.setSubmissionSink(() => {});
    await this.execution.shutdown();
  }

  start(runId: string): Promise<CrewRunDto> {
    return this.serial(runId, async () => {
      let run = this.requireRun(runId);
      try {
        if (!run.worktreePath) run = await this.execution.prepareWorkspace(run);
        return await this.drive(run.id);
      } catch (error) {
        const blocked = this.blocker.recovery(this.requireRun(run.id), reasonOf(error));
        await this.quiesceCrewRun(run.id);
        return blocked;
      }
    });
  }

  markExecutionReady(): void {
    if (this.executionReady) return;
    this.reconcileQueuedTasksBeforeExecution();
    this.tasks.markCrewQueueReconciled();
    this.executionReady = true;
    try {
      this.tasks.markCrewExecutionReady();
    } catch (error) {
      this.executionReady = false;
      throw error;
    }
  }

  runExclusive(runId: string, operation: () => Promise<CrewRunDto>): Promise<CrewRunDto> {
    return this.serial(runId, operation);
  }

  acceptSubmission(notice: CrewSubmissionNotice): Promise<CrewRunDto> {
    return this.serial(notice.runId, async () => {
      try {
        if (notice.result.result.kind === 'builder-intent'
          || notice.result.result.kind === 'synthesis') return this.requireRun(notice.runId);
        const run = await this.stages.accept(notice);
        return await this.drive(run.id);
      } catch (error) {
        return await this.handleOperationFailure(notice.runId, error);
      }
    });
  }

  handleTaskFinished(task: TaskDto): Promise<CrewRunDto | null> {
    if (task.executionKind !== 'crew-member' || !task.crewRunId || !task.crewMemberKey) {
      return Promise.resolve(null);
    }
    return this.serial(task.crewRunId, async () => {
      try {
        let run = this.requireRun(task.crewRunId!);
        if (run.status === 'TERMINAL') {
          await this.quiesceCrewRun(run.id);
          return this.requireRun(run.id);
        }
        if (task.status === 'CANCELLED') return run;
        if (run.status !== 'RUNNING' || run.phase !== task.crewPhase) return run;
        const member = this.members.findCurrent(run.id, task.crewMemberKey!);
        if (!member) return this.blocker.provider(run, 'Crew member settlement has no current member');
        if (task.crewAttemptKey !== expectedCrewAttemptKey(run)) return run;
        const currentResult = findCurrentCrewResult(this.results, run, member);
        if (run.phase === 'BUILD' && currentResult?.result.kind === 'builder-intent') {
          const final = await this.finalizer.finalizeSettled(run.id, member.id);
          run = await this.stages.accept(final);
          return await this.drive(run.id);
        }
        if (currentResult) {
          if (currentResult.result.kind === 'synthesis') {
            await this.quiesceCrewRun(run.id);
            return await this.stages.accept(noticeFromResult(run, member.memberKey, currentResult));
          }
          run = await this.stages.accept(noticeFromResult(run, member.memberKey, currentResult));
          return await this.drive(run.id);
        }
        return this.blocker.provider(run, 'Crew member settled without a structured result');
      } catch (error) {
        return await this.handleOperationFailure(task.crewRunId!, error);
      }
    });
  }

  async drive(runId: string): Promise<CrewRunDto> {
    let run = this.requireRun(runId);
    if (this.destroyed || this.database.closed) return run;
    if (run.status === 'TERMINAL') return run;
    if (run.status === 'BLOCKED_USER' || run.status === 'BLOCKED_PROVIDER') {
      this.blocker.raise(run, run.blockedReason ?? 'blocked'); return run;
    }
    if (run.status !== 'QUEUED') return run;
    try {
      if (run.phase === 'PLAN') return await this.execution.startMember(
        run, 'foreman', { type: 'plan_started' }, 'Plan the objective',
      );
      if (run.phase === 'BUILD') return await this.execution.startBuilder(run);
      if (run.phase === 'VERIFY') {
        const next = await this.execution.runVerify(run);
        return next.status === 'QUEUED' ? await this.drive(next.id) : next;
      }
      if (run.phase === 'REVIEW') return await this.execution.startReview(run);
      if (run.phase === 'SYNTHESIZE') {
        await this.gates.assertCurrent(run);
        return await this.execution.startMember(
          run, 'foreman', { type: 'foreman_claimed' }, 'Synthesize the final result',
        );
      }
      return run;
    } catch (error) {
      run = this.requireRun(run.id);
      if (error instanceof CrewProviderAttemptError) return this.blocker.provider(run, error.message);
      return this.blocker.recovery(run, reasonOf(error));
    }
  }

  abortVerification(runId: string): Promise<void> {
    return this.execution.abortVerification(runId);
  }

  async quiesceCrewRun(runId: string): Promise<void> {
    await this.quiescer.quiesce(runId, this.abortVerification(runId));
  }

  private reconcileQueuedTasksBeforeExecution(): void {
    const queued = this.tasks.listInternal().filter((task) =>
      task.executionKind === 'crew-member' && task.status === 'QUEUED',
    );
    for (const task of queued) {
      const run = task.crewRunId ? this.runs.findById(task.crewRunId) : null;
      const member = run && task.crewMemberKey
        ? this.members.findCurrent(run.id, task.crewMemberKey)
        : null;
      const current = run?.status === 'RUNNING'
        && task.crewPhase === run.phase
        && task.crewMemberKey === memberKeyForPhase(run.phase)
        && task.crewAttemptKey === expectedCrewAttemptKey(run)
        && member?.sessionId === task.sessionId;
      if (current) continue;
      this.tasks.cancelCrewMember(task.id);
    }
  }

  private async handleOperationFailure(runId: string, error: unknown): Promise<CrewRunDto> {
    const blocked = this.blocker.recovery(this.requireRun(runId), reasonOf(error));
    await this.quiesceCrewRun(runId);
    return blocked;
  }

  private requireRun(id: string): CrewRunDto {
    const run = this.runs.findById(id); if (!run) throw new Error(`CrewRun ${id} not found`); return run;
  }
  private serial<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(runId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(() => {
      if (this.destroyed || this.database.closed) return this.requireRun(runId) as T;
      return operation();
    });
    this.chains.set(runId, next);
    const cleanup = () => { if (this.chains.get(runId) === next) this.chains.delete(runId); };
    void next.then(cleanup, cleanup);
    return next;
  }
}

function noticeFromResult(
  run: CrewRunDto, memberKey: string,
  result: ReturnType<CrewResultsRepository['create']>,
): CrewSubmissionNotice {
  const kind = result.result.kind === 'builder' || result.result.kind === 'builder-intent'
    ? 'build' : result.result.kind;
  return { runId: run.id, memberKey, kind, result, workspaceHead: result.workspaceHead ?? run.workspaceHead! };
}
function reasonOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function memberKeyForPhase(phase: CrewRunDto['phase']): string | null {
  if (phase === 'PLAN' || phase === 'SYNTHESIZE') return 'foreman:primary';
  if (phase === 'BUILD') return 'builder:primary';
  if (phase === 'REVIEW') return 'reviewer:primary';
  return null;
}
function isBootInterruptedCrewTask(task: TaskDto): boolean {
  return task.executionKind === 'crew-member' && task.status === 'FAILED'
    && task.outcome?.reason === 'daemon_restart';
}
