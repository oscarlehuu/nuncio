import { Inject, Injectable } from '@nestjs/common';
import type { AgentRuntimePolicy } from '../agents/agents.types';
import { CrewContextService } from './crew-context.service';
import {
  CREW_MEMBER_EXECUTION_PORT, type CrewAttemptHandle, type CrewMemberExecutionPort,
} from './crew-execution.ports';
import { CrewNotFoundError, CrewValidationError } from './domain/crew-errors';
import type { CrewRole, CrewRunDto } from './domain/crew.types';
import {
  CrewMembersRepository, type CrewMemberSessionDto,
} from './persistence/crew-members.repository';
import { CrewRunsRepository } from './persistence/crew-runs.repository';
import { activeCrewSubmission, crewToolAuthority } from './crew-tool-authority';

const MEMBER_KEYS: Record<CrewRole, string> = {
  foreman: 'foreman:primary', builder: 'builder:primary', reviewer: 'reviewer:primary',
};

@Injectable()
export class CrewMemberService {
  constructor(
    private readonly runs: CrewRunsRepository,
    private readonly members: CrewMembersRepository,
    private readonly context: CrewContextService,
    @Inject(CREW_MEMBER_EXECUTION_PORT) private readonly execution: CrewMemberExecutionPort,
  ) {}

  ensureMember(runId: string, role: CrewRole, fresh = false): CrewMemberSessionDto {
    const run = this.requireRun(runId);
    const memberKey = MEMBER_KEYS[role];
    const current = this.members.findCurrent(runId, memberKey);
    if (current && !fresh) return current;
    const binding = run.profileSnapshot.bindings[role];
    return this.members.replaceCurrent({
      runId, memberKey, provider: binding.provider, model: binding.model, sessionId: null,
      priorMemberSessionId: current?.id ?? null, lifecycle: 'active', contextHealth: 'new',
      lastSeenContextRevision: 0, lastSeenWorkspaceHead: null,
      lastUsedAt: Date.now(),
    });
  }

  async enqueueAttempt(
    runId: string, role: CrewRole, goal: string, idempotencyKey: string,
  ): Promise<{ member: CrewMemberSessionDto; attempt: CrewAttemptHandle }> {
    const run = this.requireRun(runId);
    if (!run.worktreePath || !run.workspaceHead) throw new CrewValidationError('Crew workspace is not prepared');
    const member = this.ensureMember(runId, role);
    const envelope = !member.sessionId || member.contextHealth !== 'healthy'
      ? this.context.buildEnvelope(runId, role, goal)
      : this.context.buildDelta(runId, role, goal, member.lastSeenContextRevision);
    const runtimePolicy: AgentRuntimePolicy = {
      filesystem: role === 'builder' ? 'workspace-write' : 'read-only',
      workspaceRoot: run.worktreePath, network: 'disabled',
    };
    const attempt = await this.execution.startAttempt({
      idempotencyKey, runId, memberKey: member.memberKey, phase: run.phase,
      prompt: renderEnvelope(envelope, run, member), provider: member.provider, model: member.model,
      workspace: run.worktreePath, runtimePolicy, existingSessionId: member.sessionId,
    });
    const attached = attempt.sessionId && member.sessionId !== attempt.sessionId
      ? this.members.attachSession(member.id, attempt.sessionId)
      : member;
    const seen = this.members.updateSeen(attached.id, run.contextRevision, run.workspaceHead);
    return { member: seen, attempt };
  }

  attachSettledSession(runId: string, memberKey: string, sessionId: string): CrewMemberSessionDto {
    const current = this.members.findCurrent(runId, memberKey);
    if (!current) throw new CrewNotFoundError('CrewMember', `${runId}:${memberKey}`);
    return current.sessionId === sessionId ? current : this.members.attachSession(current.id, sessionId);
  }
  canResumeSession(sessionId: string): Promise<boolean> {
    return this.execution.canResumeSession(sessionId);
  }
  private requireRun(id: string): CrewRunDto {
    const run = this.runs.findById(id);
    if (!run) throw new CrewNotFoundError('CrewRun', id);
    if (run.status === 'TERMINAL') throw new CrewValidationError('terminal CrewRun cannot start members');
    return run;
  }
}

function renderEnvelope(
  envelope: ReturnType<CrewContextService['buildEnvelope']> | ReturnType<CrewContextService['buildDelta']>,
  run: CrewRunDto,
  member: CrewMemberSessionDto,
): string {
  const activeTool = activeCrewSubmission(run, member);
  const authority = activeTool ? crewToolAuthority(run, member, activeTool) : null;
  const tool = activeTool ? {
    activeTool: `submit_${activeTool}`,
    authority,
    readArtifactAuthority: { ...authority!, idempotencyKey: `${authority!.idempotencyKey}:read` },
  } : { activeTool: null, authority: null };
  return [
    'Nuncio Crew role envelope (structured, authoritative):',
    JSON.stringify({ ...envelope, tool }, null, 2),
  ].join('\n');
}
