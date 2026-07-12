import type { CrewSubmissionKind, CrewToolAuthority } from './crew-runtime-tool.schemas';
import type { CrewRunDto } from './domain/crew.types';
import type { CrewMemberSessionDto } from './persistence/crew-members.repository';

export function activeCrewSubmission(
  run: CrewRunDto, member: Pick<CrewMemberSessionDto, 'memberKey'>,
): CrewSubmissionKind | null {
  const map: Record<string, CrewSubmissionKind> = {
    'PLAN:foreman:primary': 'plan', 'BUILD:builder:primary': 'build',
    'REVIEW:reviewer:primary': 'review', 'SYNTHESIZE:foreman:primary': 'synthesis',
  };
  return map[`${run.phase}:${member.memberKey}`] ?? null;
}

export function crewToolAuthority(
  run: CrewRunDto, member: Pick<CrewMemberSessionDto, 'id' | 'memberKey'>,
  kind: CrewSubmissionKind,
): CrewToolAuthority {
  if (!run.workspaceHead) throw new Error('Crew tool authority requires a workspace head');
  return {
    runId: run.id, memberKey: member.memberKey, contextRevision: run.contextRevision,
    workspaceHead: run.workspaceHead,
    idempotencyKey: `crew:${run.id}:${run.revision}:${member.id}:${kind}`,
  };
}
