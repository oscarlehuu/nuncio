import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { defineCrewRuntimeTool } from '../agents/tools/agent-runtime-tools-policy';
import { AgentToolRegistry } from '../agents/tools/agent-tool-registry';
import type {
  AgentRuntimeTool, AgentRuntimeToolScope, AgentRuntimeToolSource, AgentRuntimeTools,
} from '../agents/tools/agent-runtime-tools.types';
import { CrewArtifactStore } from './crew-artifact.store';
import { CrewRuntimeMemberResolver } from './crew-runtime-member-resolver.service';
import {
  CREW_WORKSPACE_PORT, type CrewWorkspacePort,
} from './crew-execution.ports';
import { assertCrewToolAuthority, parseCrewSubmission } from './crew-runtime-tool.validate';
import {
  crewArtifactReadSchema, crewSubmissionSchema, PHASE_FOR_SUBMISSION,
  type CrewSubmissionKind, type CrewToolAuthority,
} from './crew-runtime-tool.schemas';
import type { CrewRunDto } from './domain/crew.types';
import { CrewMembersRepository, type CrewMemberSessionDto } from './persistence/crew-members.repository';
import { CrewResultsRepository, type CrewMemberResultDto } from './persistence/crew-results.repository';
import { CrewRunsRepository } from './persistence/crew-runs.repository';
import { CrewWriterLeaseService } from './crew-writer-lease.service';
import { activeCrewSubmission, crewToolAuthority } from './crew-tool-authority';

export interface CrewSubmissionNotice {
  runId: string; memberKey: string; kind: CrewSubmissionKind;
  result: CrewMemberResultDto; workspaceHead: string;
}
type SubmissionSink = (submission: CrewSubmissionNotice) => void | Promise<void>;

const READ_ONLY = { filesystem: 'read-only', network: 'disabled' } as const;
const WORKSPACE_WRITE = { filesystem: 'workspace-write', network: 'disabled' } as const;

@Injectable()
export class CrewRuntimeToolsService implements AgentRuntimeToolSource, OnModuleInit, OnModuleDestroy {
  private unregister?: () => void;
  private sink: SubmissionSink = () => {};
  constructor(
    private readonly registry: AgentToolRegistry,
    private readonly memberResolver: CrewRuntimeMemberResolver,
    private readonly runs: CrewRunsRepository,
    private readonly members: CrewMembersRepository,
    private readonly results: CrewResultsRepository,
    private readonly artifacts: CrewArtifactStore,
    private readonly leases: CrewWriterLeaseService,
    @Inject(CREW_WORKSPACE_PORT) private readonly workspace: CrewWorkspacePort,
  ) {}
  onModuleInit(): void { this.unregister = this.registry.registerSource(this); }
  onModuleDestroy(): void { this.unregister?.(); }
  setSubmissionSink(sink: SubmissionSink): void { this.sink = sink; }

  forSession(scope: AgentRuntimeToolScope): AgentRuntimeTools | undefined {
    const member = this.memberResolver.resolve(scope.sessionId);
    if (!member?.isCurrent) return undefined;
    const run = this.runs.findById(member.runId);
    if (!run || run.status !== 'RUNNING' || !run.workspaceHead || !run.worktreePath) return undefined;
    const kinds = submissionKindsFor(member);
    if (kinds.length === 0) return undefined;
    const activeKind = activeCrewSubmission(run, member);
    return {
      systemPromptAppend: renderToolAuthority(run, member, activeKind),
      tools: [...kinds.map((kind) => this.submissionTool(
        scope.sessionId, run, member, kind, crewToolAuthority(run, member, kind),
      )), this.artifactTool(run, member, crewToolAuthority(run, member, activeKind ?? kinds[0]!))],
    };
  }

  private submissionTool(
    sessionId: string, run: CrewRunDto, member: CrewMemberSessionDto,
    kind: CrewSubmissionKind, authority: CrewToolAuthority,
  ): AgentRuntimeTool {
    return defineCrewRuntimeTool({
      name: `submit_${kind}`, description: `Submit structured ${kind} evidence to Nuncio Crew.`,
      inputSchema: crewSubmissionSchema(kind),
      security: {
        network: 'disabled', workspaceMutation: kind === 'build' ? 'workspace' : 'none',
        runtimePolicies: kind === 'build' ? [WORKSPACE_WRITE] : [READ_ONLY], scope: 'crew-internal',
      },
      ...(PHASE_FOR_SUBMISSION[kind] === run.phase ? { testInput: () => ({ ...authority }) } : {}),
      execute: (input) => this.submit(sessionId, run.revision, member.id, kind, authority, input),
    });
  }

  private artifactTool(run: CrewRunDto, member: CrewMemberSessionDto, authority: CrewToolAuthority): AgentRuntimeTool {
    return defineCrewRuntimeTool({
      name: 'read_crew_artifact', description: 'Read a bounded range of one artifact from this CrewRun.',
      inputSchema: crewArtifactReadSchema(),
      security: {
        network: 'disabled', workspaceMutation: 'none', runtimePolicies: [READ_ONLY, WORKSPACE_WRITE],
        scope: 'crew-internal',
      },
      execute: async (input) => {
        const readAuthority = { ...authority, idempotencyKey: `${authority.idempotencyKey}:read` };
        await this.revalidate(run.id, run.revision, member.id, readAuthority, input, true);
        const range = this.artifacts.readRange(
          run.id, requiredString(input.artifactId, 'artifactId'),
          optionalInteger(input.offset, 0), optionalInteger(input.limit, 16_384),
        );
        return toolResult(range);
      },
    });
  }

  private async submit(
    sessionId: string, runRevision: number, memberId: string, kind: CrewSubmissionKind,
    authority: CrewToolAuthority, input: Record<string, unknown>,
  ) {
    assertCrewToolAuthority(input, authority);
    const existing = this.results.findIdempotent(authority.runId, authority.idempotencyKey);
    if (existing) return toolResult({ resultId: existing.id, workspaceHead: existing.workspaceHead, duplicate: true });
    const { run, member } = await this.revalidate(
      authority.runId, runRevision, memberId, authority, input, kind !== 'build', sessionId,
    );
    if (PHASE_FOR_SUBMISSION[kind] !== run.phase || activeCrewSubmission(run, member) !== kind) {
      throw new Error('Crew submission stage is stale');
    }
    if (kind === 'build') {
      const lease = this.leases.get(run.id);
      if (!lease || lease.memberSessionId !== member.id || lease.startingHead !== authority.workspaceHead) {
        throw new Error('Builder has no matching writer lease');
      }
    }
    const workspaceHead = authority.workspaceHead;
    const resultValue = parseCrewSubmission(kind, input.result, authority.workspaceHead, workspaceHead);
    const attempt = this.results.listByRun(run.id)
      .filter((result) => result.memberSessionId === member.id && result.phase === run.phase).length + 1;
    const persisted = this.results.createIdempotent({
      runId: run.id, memberSessionId: member.id, phase: run.phase, attempt,
      result: resultValue, basedOnContextRevision: run.contextRevision, workspaceHead,
    }, authority.idempotencyKey);
    if (persisted.created) {
      try { await this.sink({ runId: run.id, memberKey: member.memberKey, kind, result: persisted.result, workspaceHead }); }
      catch { /* durable result is replayed by recovery */ }
    }
    return toolResult({ resultId: persisted.result.id, workspaceHead, duplicate: !persisted.created });
  }

  private async revalidate(
    runId: string, revision: number, memberId: string, authority: CrewToolAuthority,
    input: Record<string, unknown>, requireClean: boolean, sessionId?: string,
  ) {
    assertCrewToolAuthority(input, authority);
    const run = this.runs.findById(runId);
    const member = this.members.listByRun(runId).find((item) => item.id === memberId);
    if (!run || !member || !member.isCurrent || (sessionId && member.sessionId !== sessionId)) {
      throw new Error('Crew tool member scope is stale');
    }
    if (run.revision !== revision || run.contextRevision !== authority.contextRevision
      || run.workspaceHead !== authority.workspaceHead || run.status !== 'RUNNING') {
      throw new Error('Crew tool run scope is stale');
    }
    const boundary = await this.workspace.inspectBoundary(run.worktreePath!, {
      expectedBranch: run.branch ?? undefined, expectedCanonicalPath: run.worktreePath!,
    });
    if (!boundary.ok || !boundary.reachable || boundary.fullHead !== authority.workspaceHead
      || (requireClean && !boundary.clean)) throw new Error(`Crew workspace scope is stale: ${boundary.reason ?? 'dirty'}`);
    const currentRun = this.runs.findById(runId);
    const currentMember = this.members.listByRun(runId).find((item) => item.id === memberId);
    if (!currentRun || !currentMember || !currentMember.isCurrent
      || (sessionId && currentMember.sessionId !== sessionId)
      || currentRun.revision !== revision || currentRun.contextRevision !== authority.contextRevision
      || currentRun.workspaceHead !== authority.workspaceHead || currentRun.status !== 'RUNNING') {
      throw new Error('Crew tool run scope is stale after workspace validation');
    }
    return { run: currentRun, member: currentMember };
  }

}

function submissionKindsFor(member: CrewMemberSessionDto): CrewSubmissionKind[] {
  if (member.memberKey === 'foreman:primary') return ['plan', 'synthesis'];
  if (member.memberKey === 'builder:primary') return ['build'];
  if (member.memberKey === 'reviewer:primary') return ['review'];
  return [];
}
function renderToolAuthority(
  run: CrewRunDto, member: CrewMemberSessionDto, activeKind: CrewSubmissionKind | null,
): string {
  const authorities = Object.fromEntries(submissionKindsFor(member).map((kind) => [
    `submit_${kind}`, crewToolAuthority(run, member, kind),
  ]));
  return [
    `Active Crew stage: ${activeKind ? `submit_${activeKind}` : 'none'}.`,
    'Use only the active submit tool. Copy its authority fields exactly:',
    JSON.stringify(authorities),
  ].join('\n');
}
function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value };
}
function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${field} is required`); return value;
}
function optionalInteger(value: unknown, fallback: number): number {
  return value === undefined ? fallback : Number(value);
}
