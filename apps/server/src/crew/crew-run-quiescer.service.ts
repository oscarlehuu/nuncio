import { Injectable } from '@nestjs/common';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { CrewMembersRepository } from './persistence/crew-members.repository';
import { resolveCrewTaskStopTarget } from './crew-task-stop-target';
import { CrewWriterLeaseService } from './crew-writer-lease.service';

@Injectable()
export class CrewRunQuiescerService {
  constructor(
    private readonly tasks: TasksService,
    private readonly sessions: SessionsService,
    private readonly members: CrewMembersRepository,
    private readonly leases: CrewWriterLeaseService,
  ) {}

  async quiesce(runId: string, verification: Promise<void>): Promise<void> {
    const verificationStop = Promise.allSettled([verification]);
    const allTasks = this.tasks.listInternal();
    const tasks = allTasks.filter((task) =>
      task.crewRunId === runId && (task.status === 'QUEUED' || task.status === 'RUNNING'),
    );
    const protectedSessions = new Set(allTasks.filter((task) =>
      task.crewRunId !== runId && (task.status === 'QUEUED' || task.status === 'RUNNING') && task.sessionId,
    ).map((task) => task.sessionId!));
    const sessionIds = new Set(this.members.listByRun(runId)
      .filter((member) => member.isCurrent && member.sessionId && !protectedSessions.has(member.sessionId))
      .map((member) => member.sessionId!));
    const targets = await Promise.all(tasks.filter((item) => item.status === 'RUNNING')
      .map(async (task) => ({ taskId: task.id, ...await resolveCrewTaskStopTarget(this.tasks, task.id) })));
    for (const target of targets) {
      if (target.sessionId && !protectedSessions.has(target.sessionId)) sessionIds.add(target.sessionId);
    }
    const stops = [
      ...await Promise.allSettled([...sessionIds].map((id) => this.sessions.quiesceCrewSession(id))),
      ...await verificationStop,
    ];
    const failed = stops.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    const unresolved = targets.find((target) => target.unresolved);
    if (unresolved) throw new Error(`Crew task ${unresolved.taskId} session attachment did not settle`);
    for (const task of tasks) {
      const current = this.tasks.findById(task.id);
      if (current && (current.status === 'QUEUED' || current.status === 'RUNNING')) {
        try { this.tasks.cancelCrewMember(task.id); } catch { /* task settled concurrently */ }
      }
    }
    const lease = this.leases.get(runId);
    if (lease) this.leases.release(runId, lease.token);
  }
}
