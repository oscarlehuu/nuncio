import { activeCrewSubmission, crewToolAuthority } from './crew-tool-authority';
import type { CrewRunDto } from './domain/crew.types';
import type { CrewMemberSessionDto } from './persistence/crew-members.repository';
import type { CrewResultsRepository } from './persistence/crew-results.repository';

export function expectedCrewAttemptKey(run: CrewRunDto): string {
  const finalReview = run.phase === 'REVIEW' && run.context.finalReview
    && typeof run.context.finalReview === 'object'
    && (run.context.finalReview as Record<string, unknown>).status === 'active';
  return finalReview
    ? `runner:final-review:attempt:${run.revision}`
    : `runner:${run.phase.toLowerCase()}:attempt:${run.revision}`;
}

export function findCurrentCrewResult(
  results: CrewResultsRepository, run: CrewRunDto, member: CrewMemberSessionDto,
) {
  const kind = activeCrewSubmission(run, member);
  return kind ? results.findIdempotent(
    run.id, crewToolAuthority(run, member, kind).idempotencyKey,
  ) : null;
}
