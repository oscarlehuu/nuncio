import { CrewGateEvidenceService } from '../../../src/crew/crew-gate-evidence.service';

const head = 'a'.repeat(40);
const run = {
  id: 'run-1', worktreePath: '/worktree', branch: 'nuncio/run-task', workspaceHead: head,
  baseHead: 'b'.repeat(40),
  reviewRetriesUsed: 1,
  context: {},
  profileSnapshot: { policy: { strictFreshFinalReviewer: true } },
};
const verify = {
  id: 'verify-1', runId: 'run-1', kind: 'verify-log', sha256: 'hash', byteCount: 12,
  metadata: { passed: true, workspaceHead: head }, createdAt: 1,
};
const review = {
  id: 'result-1', runId: 'run-1', memberSessionId: 'reviewer-2', phase: 'REVIEW', attempt: 2,
  result: {
    kind: 'review', summary: 'Clean with one note', workspaceHead: head,
    findings: [{ severity: 'warning', title: 'Naming', body: 'Consider a rename' }],
  }, basedOnContextRevision: 3, workspaceHead: head, createdAt: 2,
};
const diff = {
  id: 'diff-1', runId: 'run-1', kind: 'workspace-diff', sha256: 'diff-hash', byteCount: 20,
  metadata: { workspaceHead: head, baseHead: 'b'.repeat(40), truncated: false }, createdAt: 1,
};
const boundary = {
  ok: true, exists: true, symlink: false, canonicalPath: '/worktree',
  branch: 'nuncio/run-task', fullHead: head, clean: true, reachable: true, reason: null,
};

describe('CrewGateEvidenceService', () => {
  it('projects stable verify/review evidence items including non-blocking warnings', () => {
    const gates = service();
    expect(gates.items(run as never)).toEqual([
      { kind: 'verify', status: 'passed', workspaceHead: head, warnings: [], artifactId: 'verify-1' },
      {
        kind: 'review', status: 'passed', workspaceHead: head,
        warnings: ['Naming: Consider a rename'], artifactId: null,
      },
    ]);
  });

  it('projects only the latest verify and review attempt for stable kind-keyed consumers', () => {
    const failedVerify = {
      ...verify, id: 'verify-old', createdAt: 0,
      metadata: { passed: false, workspaceHead: 'b'.repeat(40) },
    };
    const failedReview = {
      ...review, id: 'review-old', createdAt: 0,
      result: {
        ...review.result, workspaceHead: 'b'.repeat(40),
        findings: [{ severity: 'blocker', title: 'Old blocker', body: 'Already fixed' }],
      },
    };
    const gates = new CrewGateEvidenceService(
      { listByRun: () => [failedVerify, verify] } as never,
      { assertIntegrity: () => {} } as never,
      { listByRun: () => [failedReview, review] } as never,
      { listByRun: () => [] } as never,
      { inspectBoundary: async () => boundary } as never,
    );
    expect(gates.items(run as never)).toEqual([
      { kind: 'verify', status: 'passed', workspaceHead: head, warnings: [], artifactId: 'verify-1' },
      {
        kind: 'review', status: 'passed', workspaceHead: head,
        warnings: ['Naming: Consider a rename'], artifactId: null,
      },
    ]);
  });

  it('ignores aborted and infrastructure verify logs during pause, then projects resumed success', async () => {
    const aborted = {
      ...verify, id: 'verify-aborted', createdAt: 2,
      metadata: { passed: false, aborted: true, spawnError: null, workspaceHead: head },
    };
    const infrastructure = {
      ...verify, id: 'verify-infrastructure', createdAt: 3,
      metadata: { passed: false, aborted: false, spawnError: 'sandbox unavailable', workspaceHead: head },
    };
    let artifacts: Array<Record<string, unknown>> = [aborted, infrastructure, diff];
    const gates = new CrewGateEvidenceService(
      { listByRun: () => artifacts } as never, { assertIntegrity: () => {} } as never,
      { listByRun: () => [review] } as never,
      { listByRun: () => [{ id: 'reviewer-2', isCurrent: true, priorMemberSessionId: 'reviewer-1' }] } as never,
      { inspectBoundary: async () => boundary } as never,
    );
    expect(gates.items({ ...run, status: 'PAUSED' } as never).find((item) => item.kind === 'verify')).toBeUndefined();

    artifacts = [aborted, infrastructure, { ...verify, createdAt: 4 }, diff];
    expect(gates.items({ ...run, status: 'RUNNING' } as never)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'verify', status: 'passed', artifactId: 'verify-1' }),
    ]));
    await expect(gates.assertCurrent(run as never)).resolves.toBeUndefined();
  });

  it('reports the review gate running while a strict distinct final review is pending', () => {
    const pending = {
      ...run,
      context: { finalReview: { status: 'pending', workspaceHead: head } },
    };
    expect(service().items(pending as never)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'review', status: 'running', workspaceHead: head }),
    ]));
  });

  it('requires current deterministic verify, blocker-free review, and a fresh strict reviewer', async () => {
    await expect(service().assertCurrent(run as never)).resolves.toBeUndefined();
    await expect(service({ verify: { ...verify, metadata: { passed: true, workspaceHead: 'b'.repeat(40) } } })
      .assertCurrent(run as never)).rejects.toThrow('verify');
    await expect(service({ review: {
      ...review, result: { ...review.result, findings: [
        { severity: 'blocker', title: 'Broken', body: 'Fix it' },
      ] },
    } }).assertCurrent(run as never)).rejects.toThrow('review');
    await expect(service({ members: [{ id: 'reviewer-1', isCurrent: true, priorMemberSessionId: null }] })
      .assertCurrent(run as never)).rejects.toThrow('fresh');
  });

  it('fails closed when the final workspace is dirty, moved, or not at the evidence head', async () => {
    await expect(service({ boundary: { ...boundary, clean: false } }).assertCurrent(run as never))
      .rejects.toThrow('workspace');
  });

  it('fails closed when the green verify artifact bytes are missing or corrupt', async () => {
    await expect(service({ integrityError: new Error('integrity check failed') }).assertCurrent(run as never))
      .rejects.toThrow('integrity');
  });

  it('requires an intact non-truncated current-head diff before synthesis', async () => {
    await expect(service({ diff: null }).assertCurrent(run as never)).rejects.toThrow('diff evidence');
    await expect(service({ diff: { ...diff, metadata: { ...diff.metadata, truncated: true } } })
      .assertCurrent(run as never)).rejects.toThrow('diff evidence');
  });
});

function service(overrides: {
  verify?: Record<string, unknown>;
  review?: Record<string, unknown>;
  members?: Array<Record<string, unknown>>;
  boundary?: Record<string, unknown>;
  integrityError?: Error;
  diff?: Record<string, unknown> | null;
} = {}) {
  return new CrewGateEvidenceService(
    { listByRun: () => [overrides.verify ?? verify,
      ...(overrides.diff === null ? [] : [overrides.diff ?? diff])] } as never,
    { assertIntegrity: () => { if (overrides.integrityError) throw overrides.integrityError; } } as never,
    { listByRun: () => [overrides.review ?? review] } as never,
    { listByRun: () => overrides.members ?? [{
      id: 'reviewer-2', isCurrent: true, priorMemberSessionId: 'reviewer-1',
    }] } as never,
    { inspectBoundary: async () => overrides.boundary ?? boundary } as never,
  );
}
