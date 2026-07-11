import { describe, expect, it } from 'vitest';
import type { CrewRunDetailDto } from './crew-api';
import {
  deriveBlockingReviewFinding,
  deriveCurrentCrewEvidenceArtifacts,
} from './crew-artifact-evidence';

describe('Crew artifact evidence', () => {
  it('selects only latest current-head human evidence in durable API order', () => {
    const run = fixture({
      artifacts: [
        artifact('old-verify', 'verify-log', 'old-head', 1),
        artifact('verify-z', 'verify-log', 'head-2', 2),
        artifact('verify-a', 'verify-log', 'head-2', 2),
        artifact('diff-current', 'workspace-diff', 'head-2', 3),
      ],
      gates: [{
        kind: 'verify', status: 'passed', workspaceHead: 'head-2', warnings: [],
        artifactId: 'verify-a',
      }],
    });

    expect(deriveCurrentCrewEvidenceArtifacts(run)).toMatchObject([
      { gate: 'verify', label: 'Verify log', artifact: { id: 'verify-a' } },
      { gate: 'review', label: 'Workspace diff', artifact: { id: 'diff-current' } },
    ]);
  });

  it('shows only the latest blocker title/body for a current-head failed review', () => {
    const run = fixture({
      gates: [{
        kind: 'review', status: 'failed', workspaceHead: 'head-2',
        warnings: [], artifactId: null,
      }],
      results: [
        review('older', 1, [{ severity: 'blocker', title: 'Old blocker', body: 'Old body' }]),
        review('latest', 2, [
          { severity: 'blocker', title: 'First blocker', body: 'First body' },
          {
            severity: 'blocker', title: 'Latest blocker', body: 'Fix the retry boundary.',
            file: '/private/retry.ts', line: 9,
          },
        ]),
      ],
    });

    expect(deriveBlockingReviewFinding(run)).toEqual({
      title: 'Latest blocker', body: 'Fix the retry boundary.',
    });
    expect(JSON.stringify(deriveBlockingReviewFinding(run))).not.toContain('/private');
  });

  it('hides a failed review blocker after Builder advances the workspace head', () => {
    const run = fixture({
      status: 'BLOCKED_USER',
      blockedReason: 'review_round_cap',
      workspaceHead: 'head-2',
      gates: [{
        kind: 'review', status: 'failed', workspaceHead: 'head-1',
        warnings: [], artifactId: null,
      }],
      results: [review('stale', 1, [{
        severity: 'blocker', title: 'Stale blocker', body: 'Old workspace only',
      }], 'head-1')],
    });

    expect(deriveBlockingReviewFinding(run)).toBeNull();
  });
});

function fixture(overrides: Record<string, unknown>): CrewRunDetailDto {
  return {
    id: 'run-1', taskId: 'task-1', priorRunId: null, phase: 'REVIEW', status: 'RUNNING',
    outcome: null, blockedReason: null, profileSnapshot: {} as never, context: {},
    contextRevision: 1, revision: 1, projectPath: '/repo', baseBranch: 'dev',
    worktreePath: '/work', branch: 'crew', workspaceHead: 'head-2', verifyRetriesUsed: 0,
    reviewRetriesUsed: 0, maxVerifyRetries: 2, maxReviewRetries: 2,
    verifyExtraRounds: 0, reviewExtraRounds: 0, members: [], gates: [], results: [],
    artifacts: [], createdAt: 1, updatedAt: 2, ...overrides,
  } as CrewRunDetailDto;
}

function artifact(id: string, kind: string, workspaceHead: string, createdAt: number) {
  const metadata = kind === 'verify-log'
    ? { workspaceHead, passed: true, exitCode: 0, durationMs: 1, timedOut: false, outputOverflow: false, postBoundaryOk: true }
    : { workspaceHead, baseHead: 'base-1', truncated: false };
  return { id, runId: 'run-1', kind, sha256: 'a'.repeat(64), byteCount: 10, metadata, retentionState: 'retained', createdAt };
}

function review(
  id: string,
  createdAt: number,
  findings: Array<Record<string, unknown>>,
  workspaceHead = 'head-2',
) {
  return {
    id, runId: 'run-1', memberSessionId: id, phase: 'REVIEW', attempt: createdAt,
    result: { kind: 'review', summary: 'review', findings, workspaceHead },
    basedOnContextRevision: 1, workspaceHead, createdAt,
  };
}
