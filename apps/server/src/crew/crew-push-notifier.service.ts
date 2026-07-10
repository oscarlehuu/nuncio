import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PushService } from '../push/push.service';
import type { CrewRunDto } from './domain/crew.types';
import { CrewRunsRepository } from './persistence/crew-runs.repository';
import { CrewTasksRepository } from './persistence/crew-tasks.repository';

export interface CrewRunPushContent {
  title: string;
  body: string;
  data: { crewTaskId: string; crewRunId: string };
}

export function crewPushContentFor(
  run: CrewRunDto,
  objective: string,
): CrewRunPushContent | null {
  const title = run.status === 'BLOCKED_USER'
    ? 'Crew needs your input'
    : run.status === 'BLOCKED_PROVIDER'
      ? 'Crew provider unavailable'
      : run.status === 'TERMINAL' && run.outcome === 'SUCCEEDED'
        ? 'Crew finished'
        : run.status === 'TERMINAL' && run.outcome === 'FAILED'
          ? 'Crew failed'
          : run.status === 'TERMINAL' && run.outcome === 'CANCELLED'
            ? 'Crew cancelled'
            : null;
  return title ? {
    title,
    body: objective,
    data: { crewTaskId: run.taskId, crewRunId: run.id },
  } : null;
}

@Injectable()
export class CrewPushNotifier implements OnModuleInit, OnModuleDestroy {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly runs: CrewRunsRepository,
    private readonly tasks: CrewTasksRepository,
    private readonly push: PushService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.runs.onChanged((run) => {
      void this.notify(run).catch(() => {});
    });
  }
  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async notify(run: CrewRunDto): Promise<void> {
    const task = this.tasks.findById(run.taskId);
    if (!task) return;
    const content = crewPushContentFor(run, task.objective);
    if (content) await this.push.broadcast(content);
  }
}
