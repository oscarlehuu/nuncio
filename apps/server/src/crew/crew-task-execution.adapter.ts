import { Injectable } from '@nestjs/common';
import { AgentRegistry } from '../agents/agents.registry';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import type { CrewAttemptInput, CrewMemberExecutionPort } from './crew-execution.ports';
import { resolveCrewTaskStopTarget } from './crew-task-stop-target';

@Injectable()
export class CrewTaskExecutionAdapter implements CrewMemberExecutionPort {
  constructor(
    private readonly tasks: TasksService,
    private readonly sessions: SessionsService,
    private readonly agents: AgentRegistry,
  ) {}
  async startAttempt(input: CrewAttemptInput) {
    const active = this.tasks.listInternal().filter((task) =>
      task.executionKind === 'crew-member' && task.crewRunId === input.runId
      && task.crewMemberKey === input.memberKey && task.crewPhase === input.phase
      && (task.status === 'QUEUED' || task.status === 'RUNNING'),
    );
    const exact = active.find((task) => task.crewAttemptKey === input.idempotencyKey);
    if (exact) {
      return { taskId: exact.id, sessionId: exact.sessionId, continued: exact.sessionId != null };
    }
    const targets = await Promise.all(active.filter((task) => task.status === 'RUNNING')
      .map(async (task) => ({ taskId: task.id, ...await resolveCrewTaskStopTarget(this.tasks, task.id) })));
    const sessionIds = new Set([
      ...active.flatMap((task) => task.sessionId ?? []),
      ...targets.flatMap((target) => target.sessionId ?? []),
    ]);
    const stops = await Promise.allSettled([...sessionIds]
      .map((sessionId) => this.sessions.quiesceCrewSession(sessionId)));
    const failed = stops.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    const unresolved = targets.find((target) => target.unresolved);
    if (unresolved) throw new Error(`Crew task ${unresolved.taskId} session attachment did not settle`);
    for (const stale of active) {
      const current = this.tasks.findById(stale.id);
      if (current && (current.status === 'QUEUED' || current.status === 'RUNNING')) {
        try { this.tasks.cancelCrewMember(stale.id); } catch { /* task settled concurrently */ }
      }
    }
    const task = this.tasks.enqueue({
      prompt: input.prompt, provider: input.provider, model: input.model,
      workspace: input.workspace, executionKind: 'crew-member', crewRunId: input.runId,
      crewMemberKey: input.memberKey, crewPhase: input.phase,
      crewAttemptKey: input.idempotencyKey,
      ...(input.existingSessionId ? { sessionId: input.existingSessionId } : {}),
      runtimePolicy: input.runtimePolicy, verifyOwner: 'crew',
    });
    return {
      taskId: task.id, sessionId: task.sessionId,
      continued: input.existingSessionId != null,
    };
  }
  async canResumeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const provider = this.agents.resolveForSession(session);
    return provider.canResumeThread?.(session) ?? false;
  }
}
