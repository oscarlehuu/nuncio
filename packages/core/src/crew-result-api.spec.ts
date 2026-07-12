import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCrewRun } from './crew-api';
import { configureApiClient } from './http';

const run = {
  id: 'run-1',
  taskId: 'task-1',
  phase: 'DONE',
  status: 'TERMINAL',
  outcome: 'SUCCEEDED',
  revision: 9,
  contextRevision: 4,
  projectPath: '/repo',
  workspaceHead: 'head-2',
  profileSnapshot: {},
};

const row = (overrides: Record<string, unknown>) => ({
  id: `result-${String(overrides.phase).toLowerCase()}`,
  runId: run.id,
  memberSessionId: 'member-1',
  phase: overrides.phase,
  attempt: 1,
  basedOnContextRevision: 4,
  workspaceHead: 'head-2',
  createdAt: 10,
  ...overrides,
});

const response = (results: unknown[]) => ({
  ok: true,
  status: 200,
  json: vi.fn().mockResolvedValue({
    run,
    members: [],
    results,
    artifacts: [],
    gates: {},
  }),
}) as unknown as Response;

describe('Crew result transport', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    configureApiClient({ fetchImpl: fetchMock });
  });

  afterEach(() => {
    configureApiClient({ fetchImpl: (...args) => globalThis.fetch(...args) });
  });

  it('parses every member-result variant and strips unknown transport metadata', async () => {
    fetchMock.mockResolvedValue(response([
      row({
        phase: 'PLAN',
        result: {
          kind: 'plan', summary: 'Plan it', steps: ['Inspect'], openQuestions: [],
          materialClarification: 'Which branch?', rawLogPath: '/private/plan.log',
        },
        relativeStoragePath: 'logs/plan.json',
      }),
      row({
        phase: 'BUILD',
        result: {
          kind: 'builder-intent', summary: 'Will edit', changedFiles: ['src/a.ts'],
          basedOnWorkspaceHead: 'head-1', secret: 'discard me',
        },
      }),
      row({
        id: 'result-builder',
        phase: 'BUILD',
        attempt: 2,
        result: {
          kind: 'builder', summary: 'Edited', changedFiles: ['src/a.ts'],
          basedOnWorkspaceHead: 'head-1', commitHead: 'head-2',
        },
      }),
      row({
        phase: 'REVIEW',
        result: {
          kind: 'review', summary: 'Looks good', workspaceHead: 'head-2',
          findings: [{
            severity: 'warning', title: 'Follow-up', body: 'Consider a cache.',
            file: 'src/a.ts', line: 12, rawLogPath: '/private/review.log',
          }],
        },
      }),
      row({
        phase: 'SYNTHESIZE',
        result: {
          kind: 'synthesis', summary: 'Shipped', verification: 'All checks passed',
          remainingRisks: ['Cold cache'], workspaceHead: 'head-2',
        },
      }),
    ]));

    const detail = await fetchCrewRun(run.id);

    expect(detail.results.map(({ phase, result }) => [phase, result.kind])).toEqual([
      ['PLAN', 'plan'],
      ['BUILD', 'builder-intent'],
      ['BUILD', 'builder'],
      ['REVIEW', 'review'],
      ['SYNTHESIZE', 'synthesis'],
    ]);
    expect(detail.results[0]).toEqual(expect.objectContaining({
      phase: 'PLAN',
      result: {
        kind: 'plan', summary: 'Plan it', steps: ['Inspect'], openQuestions: [],
        materialClarification: 'Which branch?',
      },
    }));
    expect(detail.results[3]?.result).toEqual({
      kind: 'review', summary: 'Looks good', workspaceHead: 'head-2',
      findings: [{
        severity: 'warning', title: 'Follow-up', body: 'Consider a cache.',
        file: 'src/a.ts', line: 12,
      }],
    });
    expect(JSON.stringify(detail.results)).not.toMatch(/rawLogPath|relativeStoragePath|discard me/);
  });

  it('omits malformed, phase-mismatched, and cross-run result rows', async () => {
    const validResult = {
      kind: 'synthesis', summary: 'Complete', verification: 'Gate passed',
      remainingRisks: [], workspaceHead: 'head-2',
    };
    const valid = row({
      id: 'valid-synthesis',
      phase: 'SYNTHESIZE',
      result: validResult,
    });
    fetchMock.mockResolvedValue(response([
      valid,
      { ...valid, id: 'wrong-run', runId: 'run-elsewhere' },
      { ...valid, id: 'wrong-phase', phase: 'REVIEW' },
      { ...valid, id: 'bad-risk', result: { ...validResult, remainingRisks: [7] } },
      { ...valid, id: 'future', result: { kind: 'future-result' } },
    ]));

    await expect(fetchCrewRun(run.id)).resolves.toMatchObject({
      results: [expect.objectContaining({ id: 'valid-synthesis' })],
    });
  });
});
