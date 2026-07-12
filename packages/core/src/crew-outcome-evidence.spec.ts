import { describe, expect, it } from 'vitest';
import { deriveCrewOutcomeEvidence } from './crew-outcome-evidence';
import type { CrewMemberResultDto } from './crew-result-types';

function synthesis(id: string, summary: string): CrewMemberResultDto {
  return {
    id,
    runId: 'run-1',
    memberSessionId: `member-${id}`,
    phase: 'SYNTHESIZE',
    attempt: 1,
    result: {
      kind: 'synthesis', summary, verification: `${summary} verified`,
      remainingRisks: [], workspaceHead: 'head-1',
    },
    basedOnContextRevision: 1,
    workspaceHead: 'head-1',
    createdAt: 10,
  };
}

describe('deriveCrewOutcomeEvidence', () => {
  it('uses durable API order to break equal timestamp and attempt ties', () => {
    const evidence = deriveCrewOutcomeEvidence({
      status: 'TERMINAL',
      outcome: 'SUCCEEDED',
      results: [synthesis('z-first', 'First'), synthesis('a-second', 'Second')],
    });

    expect(evidence).toMatchObject({ state: 'available', summary: 'Second' });
  });

  it('does not present a submitted synthesis as final before the run succeeds', () => {
    expect(deriveCrewOutcomeEvidence({
      status: 'RUNNING',
      outcome: null,
      results: [synthesis('pending', 'Not final yet')],
    })).toBeNull();
  });

  it('does not present abandoned synthesis evidence as a cancelled outcome', () => {
    expect(deriveCrewOutcomeEvidence({
      status: 'TERMINAL',
      outcome: 'CANCELLED',
      results: [synthesis('cancelled', 'Abandoned')],
    })).toBeNull();
  });
});
