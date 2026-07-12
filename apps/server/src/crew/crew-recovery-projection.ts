import type { CrewRunDto, CrewRunProjection } from './domain/crew.types';
import type { CrewMembersRepository } from './persistence/crew-members.repository';

export function recoveryRoleForPhase(
  phase: CrewRunDto['phase'],
): 'foreman' | 'builder' | 'reviewer' | null {
  if (phase === 'BUILD') return 'builder';
  if (phase === 'REVIEW') return 'reviewer';
  if (phase === 'PLAN' || phase === 'SYNTHESIZE') return 'foreman';
  return null;
}

export function recoveryMemberForPhase(run: CrewRunDto, members: CrewMembersRepository) {
  const role = recoveryRoleForPhase(run.phase);
  return role ? members.findCurrent(run.id, `${role}:primary`) : null;
}

export function sameCrewProjection(run: CrewRunDto, replay: CrewRunProjection): boolean {
  return ['phase', 'status', 'outcome', 'blockedReason', 'revision', 'contextRevision', 'workspaceHead',
    'verifyRetriesUsed', 'reviewRetriesUsed', 'verifyExtraRounds', 'reviewExtraRounds']
    .every((key) => run[key as keyof CrewRunDto] === replay[key as keyof CrewRunProjection]);
}
