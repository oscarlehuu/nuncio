import { Injectable } from '@nestjs/common';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { expectedCrewAttemptKey } from './crew-attempt-correlation';
import { CrewMembersRepository, type CrewMemberSessionDto } from './persistence/crew-members.repository';
import { CrewRunsRepository } from './persistence/crew-runs.repository';

@Injectable()
export class CrewRuntimeMemberResolver {
  constructor(
    private readonly tasks: TasksService,
    private readonly sessions: SessionsService,
    private readonly runs: CrewRunsRepository,
    private readonly members: CrewMembersRepository,
  ) {}

  resolve(sessionId: string): CrewMemberSessionDto | null {
    const activeTask = this.tasks.listInternal().find((item) =>
      item.executionKind === 'crew-member' && item.sessionId === sessionId
      && (item.status === 'QUEUED' || item.status === 'RUNNING')
      && item.crewRunId && item.crewMemberKey,
    );
    const fromActive = this.attachFromTask(activeTask, sessionId, false);
    if (fromActive) return fromActive;
    const originTaskId = this.sessions.get(sessionId)?.originTaskId;
    const originTask = originTaskId ? this.tasks.findById(originTaskId) : null;
    const fromOrigin = this.attachFromTask(originTask, sessionId, true);
    return fromOrigin ?? this.members.findBySessionId(sessionId);
  }

  private attachFromTask(
    task: ReturnType<TasksService['findById']> | undefined,
    sessionId: string,
    allowUnattached: boolean,
  ): CrewMemberSessionDto | null {
    if (task?.executionKind !== 'crew-member' || !task.crewRunId || !task.crewMemberKey
      || (task.status !== 'QUEUED' && task.status !== 'RUNNING')) return null;
    if (task.sessionId !== sessionId && !(allowUnattached && task.sessionId === null)) return null;
    const run = this.runs.findById(task.crewRunId);
    if (!run || task.crewAttemptKey !== expectedCrewAttemptKey(run)) return null;
    const current = this.members.findCurrent(task.crewRunId, task.crewMemberKey);
    if (!current || (current.sessionId && current.sessionId !== sessionId)) return null;
    return current.sessionId === sessionId ? current : this.members.attachSession(current.id, sessionId);
  }
}
