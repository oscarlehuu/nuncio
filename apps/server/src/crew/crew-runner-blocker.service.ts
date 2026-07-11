import { Inject, Injectable } from '@nestjs/common';
import { redactHighConfidenceSecrets } from '../git/git-sensitive-checkpoint-paths';
import { CREW_ATTENTION_PORT, type CrewAttentionPort } from './crew-execution.ports';
import type { CrewRunDto } from './domain/crew.types';
import { CrewRunsRepository } from './persistence/crew-runs.repository';

@Injectable()
export class CrewRunnerBlockerService {
  constructor(
    private readonly runs: CrewRunsRepository,
    @Inject(CREW_ATTENTION_PORT) private readonly attention: CrewAttentionPort,
  ) {}

  provider(run: CrewRunDto, reason: string): CrewRunDto {
    if (!['QUEUED', 'RUNNING', 'RECOVERING'].includes(run.status)) return run;
    const safeReason = redactCrewFailureReason(reason);
    const blocked = this.runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: `runner:provider-blocked:${run.revision}`,
      actor: 'nuncio', event: { type: 'provider_unavailable', reason: safeReason },
    });
    this.raise(blocked, safeReason);
    return blocked;
  }

  recovery(run: CrewRunDto, reason: string): CrewRunDto {
    if (run.status === 'TERMINAL' || run.status === 'PAUSED' || run.status === 'BLOCKED_USER') return run;
    const safeReason = redactCrewFailureReason(reason);
    let recovering = run;
    if (run.status !== 'RECOVERING') recovering = this.runs.applyEvent(run.id, {
      expectedRevision: run.revision, idempotencyKey: `runner:recovery-start:${run.revision}`,
      actor: 'nuncio', event: { type: 'recovery_started', reason: safeReason },
    });
    const blocked = this.runs.applyEvent(run.id, {
      expectedRevision: recovering.revision, idempotencyKey: `runner:recovery-blocked:${recovering.revision}`,
      actor: 'nuncio', event: { type: 'recovery_blocked', reason: safeReason },
    });
    this.raise(blocked, safeReason);
    return blocked;
  }

  raise(run: CrewRunDto, reason: string): void {
    const safeReason = redactCrewFailureReason(reason);
    this.attention.raise({
      kind: 'crew-blocked', subjectId: run.id, projectPath: run.projectPath,
      title: `Crew ${run.phase} needs attention`,
      payload: {
        crewTaskId: run.taskId, crewRunId: run.id,
        phase: run.phase, status: run.status, blockedReason: run.blockedReason,
        reason: safeReason,
      },
    });
  }
}

export function redactCrewFailureReason(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return redactHighConfidenceSecrets(message);
}
