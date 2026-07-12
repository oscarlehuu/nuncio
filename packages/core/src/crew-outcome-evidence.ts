import type { CrewMemberResultDto, CrewReviewResult } from './crew-result-types';

export interface CrewOutcomeReviewWarning {
  title: string;
  body: string;
}

export type CrewOutcomeEvidence =
  | {
      state: 'available';
      summary: string;
      verification: string;
      remainingRisks: string[];
      reviewWarnings: CrewOutcomeReviewWarning[];
    }
  | {
      state: 'incomplete';
      warning: string;
      reviewWarnings: CrewOutcomeReviewWarning[];
    };

interface CrewOutcomeSource {
  status: string;
  outcome: string | null;
  results: CrewMemberResultDto[];
}

export function deriveCrewOutcomeEvidence(run: CrewOutcomeSource): CrewOutcomeEvidence | null {
  const synthesis = latestResult(run.results, 'synthesis');
  const review = latestResult(run.results, 'review');
  const reviewWarnings = review
    ? (review.result as CrewReviewResult).findings
        .filter((finding) => finding.severity === 'warning')
        .map(({ title, body }) => ({ title, body }))
    : [];
  if (
    run.status === 'TERMINAL' && run.outcome === 'SUCCEEDED' &&
    synthesis?.result.kind === 'synthesis'
  ) {
    return {
      state: 'available',
      summary: synthesis.result.summary,
      verification: synthesis.result.verification,
      remainingRisks: [...synthesis.result.remainingRisks],
      reviewWarnings,
    };
  }
  if (run.status === 'TERMINAL' && run.outcome === 'SUCCEEDED') {
    return {
      state: 'incomplete',
      warning: 'Outcome evidence unavailable. This run succeeded without a synthesis result and has incomplete evidence.',
      reviewWarnings,
    };
  }
  return null;
}

function latestResult(
  results: CrewMemberResultDto[],
  kind: CrewMemberResultDto['result']['kind'],
): CrewMemberResultDto | null {
  let latest: CrewMemberResultDto | null = null;
  for (const result of results) {
    if (result.result.kind !== kind) continue;
    if (!latest || isLater(result, latest)) latest = result;
  }
  return latest;
}

function isLater(candidate: CrewMemberResultDto, current: CrewMemberResultDto): boolean {
  if (candidate.createdAt !== current.createdAt) return candidate.createdAt > current.createdAt;
  if (candidate.attempt !== current.attempt) return candidate.attempt > current.attempt;
  // The repository returns durable creation order, so the later array row wins exact ties.
  return true;
}
