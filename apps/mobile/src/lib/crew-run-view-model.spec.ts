import { describe, expect, it } from 'vitest';
import type {
  CrewMemberResult,
  CrewMemberResultDto,
  CrewMemberResultPhase,
  CrewRunDetailDto,
} from '@nuncio/core/crew-api';

function run(overrides: Partial<CrewRunDetailDto> = {}): CrewRunDetailDto {
  return {
    id: 'run-1',
    taskId: 'task-1',
    priorRunId: null,
    phase: 'BUILD',
    status: 'RECOVERING',
    outcome: null,
    blockedReason: null,
    profileSnapshot: {
      presetId: 'quality',
      sourceProfileId: 'profile-1',
      sourceProfileRevision: 1,
      resolvedAt: 1,
      bindings: {
        foreman: { provider: 'claude', model: 'fable', runtimePolicy: 'read-only' },
        builder: { provider: 'codex', model: 'sol', runtimePolicy: 'workspace-write' },
        reviewer: { provider: 'claude', model: 'opus', runtimePolicy: 'read-only' },
      },
      tester: { kind: 'nuncio', runtimePolicy: 'read-only' },
      policy: {
        verifyCommand: 'bun test',
        maxVerifyRetries: 2,
        maxReviewRetries: 2,
        strictFreshFinalReviewer: true,
      },
    },
    context: {},
    contextRevision: 0,
    revision: 3,
    projectPath: '/repo',
    baseBranch: 'dev',
    worktreePath: '/worktree',
    branch: 'nuncio/run-1',
    workspaceHead: 'abc123',
    verifyRetriesUsed: 0,
    reviewRetriesUsed: 0,
    maxVerifyRetries: 2,
    maxReviewRetries: 2,
    verifyExtraRounds: 0,
    reviewExtraRounds: 0,
    members: [],
    gates: [],
    results: [],
    artifacts: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('buildCrewRunViewModel', () => {
  it('keeps the current phase visible while a run is recovering', async () => {
    const module = (await import('./crew-run-view-model')) as Record<string, unknown>;
    expect(typeof module.buildCrewRunViewModel).toBe('function');
    const build = module.buildCrewRunViewModel as (value: CrewRunDetailDto) => {
      summary: string;
      steps: Array<{ label: string; state: string }>;
    };

    const view = build(run());
    expect(view.summary).toBe('Build · Recovering');
    expect(view.steps.find((step) => step.label === 'Build')?.state).toBe('current');
  });

  it('exposes only a successor action after terminal success', async () => {
    const module = (await import('./crew-run-view-model')) as Record<string, unknown>;
    const build = module.buildCrewRunViewModel as (value: CrewRunDetailDto) => {
      actions: string[];
      outcomeLabel: string | null;
    };
    const view = build(run({ phase: 'DONE', status: 'TERMINAL', outcome: 'SUCCEEDED' }));
    expect(view.actions).toEqual(['successor']);
    expect(view.outcomeLabel).toBe('Succeeded');
    expect(view.actions).not.toContain('publish');
    expect(view.actions).not.toContain('accept-exception');
  });

  it.each(['FAILED', 'CANCELLED'] as const)('settles terminal %s progress without a current step', async (outcome) => {
    const module = (await import('./crew-run-view-model')) as Record<string, unknown>;
    const build = module.buildCrewRunViewModel as (value: CrewRunDetailDto) => {
      steps: Array<{ label: string; state: string }>;
    };
    const view = build(run({ phase: 'DONE', status: 'TERMINAL', outcome }));
    expect(view.steps.some((step) => step.state === 'current')).toBe(false);
    expect(view.steps.find((step) => step.label === 'Done')?.state).toBe(outcome.toLowerCase());
  });

  it('keeps failed evidence visible when the workspace head advances', async () => {
    const module = (await import('./crew-run-view-model')) as Record<string, unknown>;
    const build = module.buildCrewRunViewModel as (
      value: CrewRunDetailDto,
      events: unknown[],
    ) => { gates: Array<{ kind: string; status: string }> };
    const view = build(
      run({ phase: 'VERIFY', status: 'RUNNING' }),
      [
        {
          runId: 'run-1',
          seq: 4,
          type: 'verify_completed',
          payload: { status: 'passed', workspaceHead: 'abc123' },
          idempotencyKey: 'verify-1',
          actor: 'nuncio',
          contextRevision: 0,
          workspaceHead: 'abc123',
          createdAt: 3,
        },
        {
          runId: 'run-1',
          seq: 5,
          type: 'workspace_advanced',
          payload: { workspaceHead: 'def456' },
          idempotencyKey: 'head-2',
          actor: 'nuncio',
          contextRevision: 1,
          workspaceHead: 'def456',
          createdAt: 4,
        },
      ],
    );
    expect(view.gates).toContainEqual(expect.objectContaining({ kind: 'verify', status: 'stale' }));
  });

  it('exposes only the latest synthesis and nonblocking review warnings', async () => {
    const module = (await import('./crew-run-view-model')) as Record<string, unknown>;
    const build = module.buildCrewRunViewModel as (value: CrewRunDetailDto) => {
      outcomeEvidence: unknown;
    };
    const unsafeArtifacts = [{ relativeStoragePath: 'crew/run-1/raw-verify.log' }] as unknown as CrewRunDetailDto['artifacts'];
    const view = build(run({
      phase: 'DONE',
      status: 'TERMINAL',
      outcome: 'SUCCEEDED',
      results: [
        resultRow('old', 'SYNTHESIZE', 1, {
          kind: 'synthesis', summary: 'Old summary', verification: 'Old checks',
          remainingRisks: ['Old risk'], workspaceHead: 'head-1',
        }),
        resultRow('review', 'REVIEW', 2, {
          kind: 'review', summary: 'Reviewed', workspaceHead: 'head-2',
          findings: [
            { severity: 'blocker', title: 'Resolved blocker', body: 'Do not show this.' },
            {
              severity: 'warning', title: 'Cache follow-up', body: 'Watch cold starts.',
              file: '/private/repo/cache.ts', line: 7,
            },
          ],
        }),
        resultRow('latest', 'SYNTHESIZE', 3, {
          kind: 'synthesis', summary: 'Crew shipped the cache.',
          verification: 'bun run gate passed at head-2',
          remainingRisks: ['Cold-cache latency'], workspaceHead: 'head-2',
        }),
      ],
      artifacts: unsafeArtifacts,
    }));

    expect(view.outcomeEvidence).toEqual({
      state: 'available',
      summary: 'Crew shipped the cache.',
      verification: 'bun run gate passed at head-2',
      remainingRisks: ['Cold-cache latency'],
      reviewWarnings: [{ title: 'Cache follow-up', body: 'Watch cold starts.' }],
    });
    expect(JSON.stringify(view.outcomeEvidence)).not.toMatch(
      /Old summary|Resolved blocker|private\/repo|raw-verify\.log/,
    );
  });

  it('marks successful terminal runs without synthesis as incomplete evidence', async () => {
    const module = (await import('./crew-run-view-model')) as Record<string, unknown>;
    const build = module.buildCrewRunViewModel as (value: CrewRunDetailDto) => {
      outcomeEvidence: unknown;
    };

    expect(build(run({
      phase: 'DONE', status: 'TERMINAL', outcome: 'SUCCEEDED', results: [],
    })).outcomeEvidence).toEqual({
      state: 'incomplete',
      warning: 'Outcome evidence unavailable. This run succeeded without a synthesis result and has incomplete evidence.',
      reviewWarnings: [],
    });
  });

  it('exposes current artifact choices and the latest blocking review finding', async () => {
    const module = (await import('./crew-run-view-model')) as Record<string, unknown>;
    const build = module.buildCrewRunViewModel as (value: CrewRunDetailDto) => {
      evidenceArtifacts: Array<{ label: string; artifact: { id: string } }>;
      blockingReviewFinding: { title: string; body: string } | null;
    };
    const view = build(run({
      status: 'BLOCKED_USER',
      blockedReason: 'review_round_cap',
      workspaceHead: 'head-2',
      gates: [{
        kind: 'review', status: 'changes_requested', workspaceHead: 'head-2',
        warnings: [], artifactId: null,
      }],
      artifacts: [publicArtifact('diff-1')],
      results: [resultRow('review-blocked', 'REVIEW', 2, {
        kind: 'review', summary: 'Needs work', workspaceHead: 'head-2',
        findings: [{
          severity: 'blocker', title: 'Retry boundary', body: 'Handle the final retry.',
          file: '/private/retry.ts', line: 4,
        }],
      })],
    }));

    expect(view.evidenceArtifacts).toMatchObject([
      { label: 'Workspace diff', artifact: { id: 'diff-1' } },
    ]);
    expect(view.blockingReviewFinding).toEqual({
      title: 'Retry boundary', body: 'Handle the final retry.',
    });
    expect(JSON.stringify(view)).not.toContain('/private/retry.ts');
  });
});

function publicArtifact(id: string): CrewRunDetailDto['artifacts'][number] {
  return {
    id, runId: 'run-1', kind: 'workspace-diff', sha256: 'a'.repeat(64), byteCount: 10,
    metadata: { workspaceHead: 'head-2', baseHead: 'base-1', truncated: false },
    retentionState: 'retained' as const, createdAt: 2,
  };
}

function resultRow(
  id: string,
  phase: CrewMemberResultPhase,
  attempt: number,
  result: CrewMemberResult,
): CrewMemberResultDto {
  return {
    id, runId: 'run-1', memberSessionId: `member-${id}`, phase, attempt,
    result, basedOnContextRevision: 0, workspaceHead: 'head-2', createdAt: attempt,
  };
}
