import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import {
  CREW_WORKSPACE_PORT, type CrewWorkspacePort,
} from './crew-execution.ports';
import { CrewGateEvidenceService } from './crew-gate-evidence.service';
import { CrewMemberService } from './crew-member.service';
import { CrewRunnerService } from './crew-runner.service';
import { CrewRevisionConflictError, CrewValidationError } from './domain/crew-errors';
import type {
  CrewProfileSnapshot, CrewRole, CrewRunDto, CrewTaskDto,
} from './domain/crew.types';
import { CrewMembersRepository, type CrewMemberSessionDto } from './persistence/crew-members.repository';
import { CrewRunsRepository } from './persistence/crew-runs.repository';

@Injectable()
export class CrewSuccessorService {
  constructor(
    private readonly database: DatabaseService,
    private readonly runs: CrewRunsRepository,
    private readonly members: CrewMembersRepository,
    private readonly memberService: CrewMemberService,
    private readonly gates: CrewGateEvidenceService,
    private readonly runner: CrewRunnerService,
    @Inject(CREW_WORKSPACE_PORT) private readonly workspace: CrewWorkspacePort,
  ) {}

  async create(input: {
    task: CrewTaskDto; prior: CrewRunDto; profileSnapshot: CrewProfileSnapshot; changeRequest: string;
  }): Promise<CrewRunDto> {
    const { task, prior, profileSnapshot } = input;
    if (!prior.worktreePath || !prior.branch || !prior.workspaceHead) {
      throw new CrewValidationError('prior CrewRun has no retained workspace');
    }
    const boundary = await this.workspace.inspectBoundary(prior.worktreePath, {
      expectedBranch: prior.branch, expectedCanonicalPath: prior.worktreePath,
    });
    if (!boundary.ok || !boundary.exists || boundary.symlink || !boundary.clean || !boundary.reachable
      || boundary.fullHead !== prior.workspaceHead || boundary.canonicalPath !== prior.worktreePath) {
      throw new CrewValidationError(`prior Crew workspace cannot be continued: ${boundary.reason ?? 'changed head'}`);
    }
    const priorMembers = this.members.listByRun(prior.id).filter((member) => member.isCurrent);
    const reusable = await this.reusableSessions(priorMembers, profileSnapshot);
    let run: CrewRunDto;
    try {
      run = this.database.transaction(() => {
        const active = this.runs.listByTask(task.id).find((candidate) => candidate.status !== 'TERMINAL');
        if (active) throw new CrewRevisionConflictError(active.id, active.revision, active);
        let created = this.runs.create({
          taskId: task.id, priorRunId: prior.id, profileSnapshot,
          projectPath: task.projectPath, baseBranch: prior.baseBranch, baseHead: prior.workspaceHead,
          context: {
            objective: task.objective, changeRequest: input.changeRequest, priorRunId: prior.id,
            priorWorkspaceHead: prior.workspaceHead,
            priorSnapshot: {
              profileSnapshot: prior.profileSnapshot, contextRevision: prior.contextRevision,
              workspaceHead: prior.workspaceHead, outcome: prior.outcome,
            },
            priorOutcome: prior.context.synthesis ?? null,
            priorPlan: {
              summary: prior.context.planSummary ?? null, steps: prior.context.planSteps ?? [],
            },
            decisions: Array.isArray(prior.context.decisions) ? structuredClone(prior.context.decisions) : [],
            priorGates: this.gates.items(prior),
          },
        });
        created = this.runs.applyEvent(created.id, {
          expectedRevision: created.revision, idempotencyKey: 'successor:workspace-adopted',
          actor: 'nuncio', event: { type: 'workspace_prepared', workspaceHead: prior.workspaceHead! },
          workspace: {
            worktreePath: prior.worktreePath!, branch: prior.branch!, baseBranch: prior.baseBranch,
            baseHead: prior.workspaceHead,
          },
        });
        for (const role of ['foreman', 'builder', 'reviewer'] as const) {
          const previous = priorMembers.find((member) => member.memberKey === `${role}:primary`);
          if (previous) this.createMember(created, role, previous, reusable.get(role) ?? null);
        }
        return created;
      });
    } catch (error) {
      const active = this.runs.listByTask(task.id).find((candidate) => candidate.status !== 'TERMINAL');
      if (active) throw new CrewRevisionConflictError(active.id, active.revision, active);
      throw error;
    }
    return this.runner.start(run.id);
  }

  private async reusableSessions(
    priorMembers: CrewMemberSessionDto[], snapshot: CrewProfileSnapshot,
  ): Promise<Map<CrewRole, string>> {
    const output = new Map<CrewRole, string>();
    for (const role of ['foreman', 'builder'] as const) {
      const member = priorMembers.find((candidate) => candidate.memberKey === `${role}:primary`);
      const binding = snapshot.bindings[role];
      if (member?.sessionId && member.contextHealth === 'healthy'
        && member.provider === binding.provider && member.model === binding.model
        && await this.memberService.canResumeSession(member.sessionId).catch(() => false)) {
        output.set(role, member.sessionId);
      }
    }
    return output;
  }

  private createMember(
    run: CrewRunDto, role: CrewRole, prior: CrewMemberSessionDto, sessionId: string | null,
  ): void {
    const binding = run.profileSnapshot.bindings[role];
    this.members.replaceCurrent({
      runId: run.id, memberKey: `${role}:primary`, provider: binding.provider, model: binding.model,
      sessionId, priorMemberSessionId: prior.id, lifecycle: 'active',
      contextHealth: sessionId ? 'healthy' : 'new', lastSeenContextRevision: 0,
      lastSeenWorkspaceHead: sessionId ? run.workspaceHead : null, lastUsedAt: Date.now(),
    });
  }
}
