import { describe, expect, it } from 'vitest';
import type { CrewRunDto } from '@nuncio/core/crew-api';
import { buildCrewCommandInput, buildCrewSuccessorInput } from './crew-run-actions';

function run(overrides: Partial<CrewRunDto> = {}): CrewRunDto {
  return {
    id: 'run-1', taskId: 'task-1', priorRunId: null, phase: 'DONE', status: 'TERMINAL',
    outcome: 'SUCCEEDED', blockedReason: null, context: {}, contextRevision: 2, revision: 7,
    projectPath: '/repo', baseBranch: 'dev', worktreePath: '/worktree', branch: 'nuncio/run-1',
    workspaceHead: 'abc123', verifyRetriesUsed: 0, reviewRetriesUsed: 0, maxVerifyRetries: 2,
    maxReviewRetries: 2, verifyExtraRounds: 0, reviewExtraRounds: 0, createdAt: 1, updatedAt: 2,
    profileSnapshot: {
      presetId: 'quality', sourceProfileId: 'profile-1', sourceProfileRevision: 1, resolvedAt: 1,
      bindings: {
        foreman: { provider: 'claude', model: 'fable' },
        builder: { provider: 'codex', model: 'sol' },
        reviewer: { provider: 'claude', model: 'opus' },
      },
      tester: { kind: 'nuncio', runtimePolicy: 'read-only' },
      policy: { verifyCommand: 'bun test', maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true },
    },
    ...overrides,
  };
}

describe('revision-safe Crew mobile action payloads', () => {
  it('builds pause, clarification, and extra-round inputs with the current revision', () => {
    expect(buildCrewCommandInput(run(), 'pause')).toEqual({ expectedRevision: 7 });
    expect(buildCrewCommandInput(run(), 'clarification', '  Use SQLite  ')).toEqual({
      expectedRevision: 7,
      message: 'Use SQLite',
    });
    expect(buildCrewCommandInput(run(), 'extra-round', 'verify')).toEqual({
      expectedRevision: 7,
      gate: 'verify',
    });
  });

  it('builds an immutable successor request with expected head, run, and revision', () => {
    expect(buildCrewSuccessorInput(run(), '  Add dark mode  ')).toEqual({
      changeRequest: 'Add dark mode',
      expectedBaseHead: 'abc123',
      priorRunId: 'run-1',
      expectedRevision: 7,
    });
  });

  it('rejects empty, non-terminal, or headless successor requests', () => {
    expect(buildCrewSuccessorInput(run(), '  ')).toBeNull();
    expect(buildCrewSuccessorInput(run({ status: 'RUNNING', phase: 'BUILD', outcome: null }), 'Change')).toBeNull();
    expect(buildCrewSuccessorInput(run({ workspaceHead: null }), 'Change')).toBeNull();
  });
});
