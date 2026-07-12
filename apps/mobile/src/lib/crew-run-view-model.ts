import {
  deriveBlockingReviewFinding,
  deriveCurrentCrewEvidenceArtifacts,
  deriveCrewOutcomeEvidence,
  type CrewEventDto,
  type CrewRunDetailDto,
} from '@nuncio/core/crew-api';
import { projectCrewRun } from '@nuncio/core/crew-run-projection';

const PHASE_LABELS = {
  PLAN: 'Plan',
  BUILD: 'Build',
  VERIFY: 'Verify',
  REVIEW: 'Review',
  SYNTHESIZE: 'Synthesize',
  DONE: 'Done',
} as const;

const OUTCOME_LABELS = {
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
} as const;

export function buildCrewRunViewModel(run: CrewRunDetailDto, events: CrewEventDto[] = []) {
  const projection = projectCrewRun(run, events);
  return {
    summary: projection.summary,
    steps: projection.steps.map((step) => ({
      label: PHASE_LABELS[step.phase],
      state: step.state,
    })),
    actions: projection.actions,
    outcomeLabel: projection.run.outcome ? OUTCOME_LABELS[projection.run.outcome] : null,
    outcomeEvidence: deriveCrewOutcomeEvidence(projection.run),
    evidenceArtifacts: deriveCurrentCrewEvidenceArtifacts(projection.run),
    blockingReviewFinding: deriveBlockingReviewFinding(projection.run),
    gates: projection.run.gates,
  };
}
