import { Inject, Injectable } from '@nestjs/common';
import {
  CREW_ATTENTION_PORT, CREW_WORKSPACE_PORT, type CrewAttentionPort, type CrewWorkspacePort,
} from './crew-execution.ports';
import { CrewNotFoundError, CrewRevisionConflictError } from './domain/crew-errors';
import type { CrewRunDto } from './domain/crew.types';
import { CrewRecoveryService } from './crew-recovery.service';
import { CrewRunnerService } from './crew-runner.service';
import { CrewRunsRepository } from './persistence/crew-runs.repository';

@Injectable()
export class CrewRunControlService {
  constructor(
    private readonly runs: CrewRunsRepository,
    private readonly runner: CrewRunnerService,
    private readonly recovery: CrewRecoveryService,
    @Inject(CREW_ATTENTION_PORT) private readonly attention: CrewAttentionPort,
    @Inject(CREW_WORKSPACE_PORT) private readonly workspace: CrewWorkspacePort,
  ) {}

  async pause(id: string, expectedRevision: number): Promise<CrewRunDto> {
    return this.stop(id, expectedRevision, 'pause', { type: 'pause_requested' });
  }

  async cancel(id: string, expectedRevision: number): Promise<CrewRunDto> {
    const current = this.requireRun(id);
    if (current.outcome === 'CANCELLED') {
      this.clearBlocker(id);
      return current;
    }
    const cancelled = await this.stop(id, expectedRevision, 'cancel', { type: 'cancel_requested' });
    this.clearBlocker(id);
    return cancelled;
  }

  resume(id: string, expectedRevision: number): Promise<CrewRunDto> {
    return this.runner.runExclusive(id, async () => {
      const current = this.requireRevision(id, expectedRevision);
      if (current.status === 'BLOCKED_PROVIDER') {
        await this.runner.quiesceCrewRun(id);
        return this.recovery.retryProvider(id);
      }
      const run = this.command(id, expectedRevision, 'resume', { type: 'resume_requested' });
      return this.runner.drive(run.id);
    });
  }

  clarification(id: string, expectedRevision: number, message: string): Promise<CrewRunDto> {
    return this.runner.runExclusive(id, async () => {
      const run = this.requireRevision(id, expectedRevision);
      const clarifications = Array.isArray(run.context.clarifications)
        ? run.context.clarifications.filter((item): item is string => typeof item === 'string') : [];
      const next = this.runs.applyEvent(id, {
        expectedRevision, idempotencyKey: `api:clarification:${expectedRevision}`, actor: 'user',
        event: { type: 'clarification_resolved', basedOnContextRevision: run.contextRevision, message },
        contextPatch: { clarifications: [...clarifications, message], lastClarification: message },
      });
      this.clearBlocker(id);
      return this.runner.drive(next.id);
    });
  }

  extraRound(id: string, expectedRevision: number, gate: 'verify' | 'review'): Promise<CrewRunDto> {
    return this.runner.runExclusive(id, async () => {
      this.requireRevision(id, expectedRevision);
      const run = this.command(id, expectedRevision, `extra-round:${gate}`, {
        type: 'extra_round_approved', gate,
      });
      this.clearBlocker(id);
      return this.runner.drive(run.id);
    });
  }

  private stop(
    id: string, expectedRevision: number, name: string,
    event: Parameters<CrewRunsRepository['applyEvent']>[1]['event'],
  ): Promise<CrewRunDto> {
    this.requireRevision(id, expectedRevision);
    const verification = this.runner.abortVerification(id);
    return this.runner.runExclusive(id, async () => {
      await verification;
      const current = this.requireRevision(id, expectedRevision);
      await this.runner.quiesceCrewRun(id);
      const contextPatch = await this.pausedBuildContext(current, event);
      return this.command(
        id, expectedRevision, name, event, contextPatch,
      );
    });
  }

  private async pausedBuildContext(
    run: CrewRunDto,
    event: Parameters<CrewRunsRepository['applyEvent']>[1]['event'],
  ): Promise<Record<string, unknown> | undefined> {
    if (event.type !== 'pause_requested' || run.phase !== 'BUILD'
      || !run.worktreePath || !run.workspaceHead) return undefined;
    try {
      const boundary = await this.workspace.inspectBoundary(run.worktreePath, {
        expectedBranch: run.branch ?? undefined,
        expectedCanonicalPath: run.worktreePath,
      });
      const preservedDirty = boundary.ok && boundary.exists && !boundary.symlink
        && boundary.canonicalPath === run.worktreePath && boundary.branch === run.branch
        && boundary.fullHead === run.workspaceHead && boundary.reachable && !boundary.clean;
      return preservedDirty ? { resumeDirtyBuild: true } : undefined;
    } catch {
      return undefined;
    }
  }

  private command(
    id: string, expectedRevision: number, name: string,
    event: Parameters<CrewRunsRepository['applyEvent']>[1]['event'],
    contextPatch?: Record<string, unknown>,
  ): CrewRunDto {
    return this.runs.applyEvent(id, {
      expectedRevision, idempotencyKey: `api:${name}:${expectedRevision}`, actor: 'user', event,
      ...(contextPatch ? { contextPatch } : {}),
    });
  }

  private clearBlocker(id: string): void {
    this.attention.clear('crew-blocked', id);
  }

  private requireRevision(id: string, expectedRevision: number): CrewRunDto {
    const run = this.requireRun(id);
    if (run.revision !== expectedRevision) throw new CrewRevisionConflictError(id, expectedRevision, run);
    return run;
  }

  private requireRun(id: string): CrewRunDto {
    const run = this.runs.findById(id);
    if (!run) throw new CrewNotFoundError('CrewRun', id);
    return run;
  }
}
