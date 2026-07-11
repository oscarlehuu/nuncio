import { CrewContextService } from '../../../src/crew/crew-context.service';

const run: {
  id: string;
  contextRevision: number;
  workspaceHead: string;
  context: Record<string, unknown>;
} = {
  id: 'run-1', contextRevision: 7, workspaceHead: 'a'.repeat(40),
  context: {
    objective: 'Ship the Crew workflow',
    constraints: ['No publishing', 'One writer only'],
    decisions: [{ id: 'd1', summary: 'Use deterministic verification' }],
    doneCriteria: ['Tests green', 'Review blocker-free'],
    priorFailure: { source: 'verify', summary: 'unit test failed', hiddenReasoning: 'never expose' },
    transcript: ['private provider transcript'], hiddenReasoning: 'secret chain of thought',
  },
};
const artifacts = [{
  id: 'artifact-1', runId: 'run-1', kind: 'verify-log', byteCount: 123, sha256: 'hash',
  relativeStoragePath: 'run-1/log', metadata: { workspaceHead: run.workspaceHead },
  retentionState: 'retained', createdAt: 1,
}];

describe('CrewContextService', () => {
  it('builds a role-scoped envelope without transcripts or hidden reasoning', () => {
    const service = new CrewContextService(
      { findById: () => run } as never,
      { listByRun: () => artifacts } as never,
    );
    const envelope = service.buildEnvelope('run-1', 'builder', 'Fix verification');
    expect(envelope).toMatchObject({
      runId: 'run-1', role: 'builder', contextRevision: 7,
      objective: 'Ship the Crew workflow', goal: 'Fix verification',
      workspace: { fullHead: 'a'.repeat(40) },
      priorFailure: { source: 'verify', summary: 'unit test failed' },
      artifactRefs: [{ id: 'artifact-1', kind: 'verify-log', byteCount: 123, sha256: 'hash' }],
    });
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('private provider transcript');
    expect(serialized).not.toContain('secret chain of thought');
    expect(serialized).not.toContain('relativeStoragePath');
  });

  it('applies a deterministic UTF-8 byte budget while retaining authority fields', () => {
    const longRun = structuredClone(run);
    longRun.context.constraints = Array.from({ length: 30 }, (_, index) => `constraint-${index}-${'x'.repeat(80)}`);
    const reviewerEvidence = [
      ...artifacts,
      { ...artifacts[0]!, id: 'diff-current', kind: 'workspace-diff' },
    ];
    const service = new CrewContextService(
      { findById: () => longRun } as never,
      { listByRun: () => reviewerEvidence } as never,
    );
    const first = service.buildEnvelope('run-1', 'reviewer', 'Review current head', 600);
    const second = service.buildEnvelope('run-1', 'reviewer', 'Review current head', 600);
    expect(first).toEqual(second);
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(600);
    expect(first).toMatchObject({ runId: 'run-1', contextRevision: 7, workspace: { fullHead: 'a'.repeat(40) } });
  });

  it('rejects missing runs', () => {
    const service = new CrewContextService(
      { findById: () => null } as never,
      { listByRun: () => [] } as never,
    );
    expect(() => service.buildEnvelope('missing', 'foreman', 'Plan')).toThrow('not found');
  });

  it('gives Reviewer current-head diff and deterministic Builder evidence, never stale-head artifacts', () => {
    const currentHead = run.workspaceHead;
    const evidence = [
      { ...artifacts[0]!, id: 'old-diff', kind: 'workspace-diff', metadata: { workspaceHead: 'b'.repeat(40) } },
      { ...artifacts[0]!, id: 'current-diff', kind: 'workspace-diff', metadata: { workspaceHead: currentHead } },
      { ...artifacts[0]!, id: 'current-verify', kind: 'verify-log', metadata: { workspaceHead: currentHead } },
    ];
    const service = new CrewContextService(
      { findById: () => run } as never,
      { listByRun: () => evidence } as never,
      { listByRun: () => [{
        workspaceHead: currentHead,
        result: {
          kind: 'builder', summary: 'Implemented auth', changedFiles: ['src/auth.ts'],
          basedOnWorkspaceHead: 'c'.repeat(40), commitHead: currentHead,
        },
      }] } as never,
    );
    const envelope = service.buildEnvelope('run-1', 'reviewer', 'Review the diff');
    expect(envelope.builderEvidence).toEqual({
      summary: 'Implemented auth', changedFiles: ['src/auth.ts'], workspaceHead: currentHead,
    });
    expect(envelope.artifactRefs.map((artifact) => artifact.id)).toEqual(['current-diff', 'current-verify']);
  });

  it('projects accepted plan and latest gate evidence to the roles that need it', () => {
    const evidenceRun = structuredClone(run);
    evidenceRun.context = {
      ...evidenceRun.context,
      planSummary: 'Implement the fixed workflow', planSteps: ['Build API', 'Add tests'], openQuestions: [],
      lastBuild: { summary: 'Built API', changedFiles: ['src/api.ts'] },
      lastVerify: { passed: true, artifactId: 'verify-1' },
      lastReview: {
        summary: 'One warning', findings: [{ severity: 'warning', title: 'Name', body: 'Consider rename' }],
      },
    };
    const service = new CrewContextService(
      { findById: () => evidenceRun } as never,
      { listByRun: () => [
        ...artifacts, { ...artifacts[0]!, id: 'diff-1', kind: 'workspace-diff' },
      ] } as never,
      { listByRun: () => [] } as never,
    );
    expect(service.buildEnvelope('run-1', 'builder', 'Build')).toMatchObject({
      plan: { summary: 'Implement the fixed workflow', steps: ['Build API', 'Add tests'] },
      latestVerify: { passed: true }, latestReview: { summary: 'One warning' },
    });
    expect(service.buildEnvelope('run-1', 'reviewer', 'Review')).toMatchObject({
      plan: { summary: 'Implement the fixed workflow' }, latestBuild: { summary: 'Built API' },
      latestVerify: { artifactId: 'verify-1' },
    });
    expect(service.buildEnvelope('run-1', 'foreman', 'Synthesize')).toMatchObject({
      latestBuild: { changedFiles: ['src/api.ts'] }, latestReview: { summary: 'One warning' },
    });
  });

  it('deterministically shrinks maximum feedback in a reused-member delta without dropping authority', () => {
    const large = structuredClone(run);
    large.context = {
      ...large.context,
      priorFailure: { source: 'verify', summary: 'failure '.repeat(4000) },
      planSummary: 'plan '.repeat(2000), planSteps: Array.from({ length: 100 }, () => 'step '.repeat(200)),
      lastReview: {
        summary: 'review '.repeat(2000),
        findings: Array.from({ length: 100 }, () => ({
          severity: 'blocker', title: 'title '.repeat(100), body: 'body '.repeat(300),
        })),
      },
    };
    const service = new CrewContextService(
      { findById: () => large } as never, { listByRun: () => artifacts } as never,
    );
    const delta = service.buildDelta('run-1', 'builder', 'Fix', 6, 4096);
    expect(Buffer.byteLength(JSON.stringify(delta), 'utf8')).toBeLessThanOrEqual(4096);
    expect(delta).toMatchObject({
      runId: 'run-1', fromContextRevision: 6, contextRevision: 7,
      workspace: { fullHead: 'a'.repeat(40) },
    });
  });

  it('never truncates surviving artifact ids, hashes, or workspace heads while shrinking prose', () => {
    const exact = structuredClone(run);
    exact.context.priorFailure = { source: 'verify', summary: 'long failure '.repeat(1000) };
    const exactArtifacts = [{
      ...artifacts[0]!, id: 'artifact-exact-1234567890', sha256: 'f'.repeat(64),
      metadata: { workspaceHead: exact.workspaceHead },
    }];
    const service = new CrewContextService(
      { findById: () => exact } as never, { listByRun: () => exactArtifacts } as never,
    );
    const delta = service.buildDelta('run-1', 'builder', 'Fix', 6, 2000);
    expect(delta.workspace.fullHead).toBe(exact.workspaceHead);
    expect(delta.artifactRefs[0]).toEqual(expect.objectContaining({
      id: 'artifact-exact-1234567890', sha256: 'f'.repeat(64),
    }));
  });

  it('retains exact current diff and verify refs for Reviewer or fails closed when their minimum cannot fit', () => {
    const evidence = [
      ...Array.from({ length: 20 }, (_, index) => ({
        ...artifacts[0]!, id: `old-${index}`, kind: 'note', metadata: {},
      })),
      { ...artifacts[0]!, id: 'required-diff', kind: 'workspace-diff' },
      { ...artifacts[0]!, id: 'required-verify', kind: 'verify-log' },
    ];
    const service = new CrewContextService(
      { findById: () => run } as never, { listByRun: () => evidence } as never,
    );
    const envelope = service.buildEnvelope('run-1', 'reviewer', 'Review', 900);
    expect(envelope.artifactRefs.filter((ref) => ref.required).map((ref) => ref.id))
      .toEqual(['required-diff', 'required-verify']);
    expect(() => service.buildEnvelope('run-1', 'reviewer', 'Review', 384))
      .toThrow('authority fields exceed');
  });

  it('projects bounded successor change, prior head, plan, gates, and outcome for a fresh member', () => {
    const successor = structuredClone(run) as typeof run & { priorRunId: string };
    successor.priorRunId = 'prior-1';
    successor.context = {
      objective: 'Ship', changeRequest: 'Add audit logging', priorWorkspaceHead: 'b'.repeat(40),
      priorPlan: { summary: 'Original plan', steps: ['Build'] },
      priorOutcome: { summary: 'Original shipped', verification: 'green', remainingRisks: ['none'] },
      priorGates: [{ kind: 'verify', status: 'passed', workspaceHead: 'b'.repeat(40) }],
    };
    const service = new CrewContextService(
      { findById: () => successor } as never, { listByRun: () => [] } as never,
    );
    expect(service.buildEnvelope('run-1', 'foreman', 'Plan the change')).toMatchObject({
      changeRequest: 'Add audit logging', priorRun: { id: 'prior-1', workspaceHead: 'b'.repeat(40) },
      priorPlan: { summary: 'Original plan' }, priorOutcome: { summary: 'Original shipped' },
      priorGates: [expect.objectContaining({ kind: 'verify', status: 'passed' })],
    });
  });
});
