import { CrewReviewEvidenceService } from '../../../src/crew/crew-review-evidence.service';

const head = 'a'.repeat(40);
const baseHead = 'b'.repeat(40);
const run = {
  id: 'run-1', worktreePath: '/worktree', workspaceHead: head,
  baseBranch: 'main', baseHead, branch: 'nuncio/run',
};
const boundary = {
  ok: true, exists: true, symlink: false, clean: true, reachable: true,
  canonicalPath: '/worktree', branch: 'nuncio/run', fullHead: head, reason: null,
};

describe('CrewReviewEvidenceService', () => {
  it('stores one current-head deterministic diff artifact and reuses it idempotently', async () => {
    const diff = jest.fn(async () => ({ diff: 'diff --git a/a b/a', truncated: false }));
    const writeLog = jest.fn(() => ({ artifact: {
      id: 'diff-1', kind: 'workspace-diff', metadata: { workspaceHead: head },
    } }));
    const artifacts: Array<Record<string, unknown>> = [];
    const service = new CrewReviewEvidenceService(
      { diff, inspectBoundary: async () => boundary } as never,
      { writeLog } as never, { listByRun: () => artifacts } as never,
    );
    expect(await service.ensureCurrentDiff(run as never)).toMatchObject({ id: 'diff-1' });
    expect(writeLog).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1', kind: 'workspace-diff',
      metadata: expect.objectContaining({ workspaceHead: head, baseHead, truncated: false }),
    }));
    expect(diff).toHaveBeenCalledWith('/worktree', baseHead);
    artifacts.push({ id: 'existing', kind: 'workspace-diff', metadata: { workspaceHead: head, baseHead } });
    expect(await service.ensureCurrentDiff(run as never)).toMatchObject({ id: 'existing' });
    expect(diff).toHaveBeenCalledTimes(1);
  });

  it('classifies deterministic UI impact into the stored diff artifact metadata', async () => {
    const uiDiff = [
      'diff --git a/src/components/button.tsx b/src/components/button.tsx',
      'diff --git a/src/index.css b/src/index.css',
      'diff --git a/apps/server/src/main.ts b/apps/server/src/main.ts',
    ].join('\n');
    const writeLog = jest.fn(() => ({ artifact: { id: 'diff-ui', kind: 'workspace-diff', metadata: {} } }));
    const service = new CrewReviewEvidenceService(
      { diff: async () => ({ diff: uiDiff, truncated: false }), inspectBoundary: async () => boundary } as never,
      { writeLog } as never, { listByRun: () => [] } as never,
    );
    await service.ensureCurrentDiff(run as never);
    expect(writeLog).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        uiTouched: true,
        uiFiles: ['src/components/button.tsx', 'src/index.css'],
        uiFileCount: 2,
      }),
    }));
  });

  it('marks backend-only diffs as not UI-touching', async () => {
    const writeLog = jest.fn(() => ({ artifact: { id: 'diff-be', kind: 'workspace-diff', metadata: {} } }));
    const service = new CrewReviewEvidenceService(
      {
        diff: async () => ({ diff: 'diff --git a/apps/server/src/main.ts b/apps/server/src/main.ts', truncated: false }),
        inspectBoundary: async () => boundary,
      } as never,
      { writeLog } as never, { listByRun: () => [] } as never,
    );
    await service.ensureCurrentDiff(run as never);
    expect(writeLog).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ uiTouched: false, uiFiles: [], uiFileCount: 0 }),
    }));
  });

  it('persists overflow evidence but fails closed instead of sending a partial diff to Reviewer', async () => {
    const stored = {
      id: 'overflow', kind: 'workspace-diff', metadata: { workspaceHead: head, baseHead, truncated: true },
    };
    const existing: Array<typeof stored> = [];
    const writeLog = jest.fn(() => { existing.push(stored); return { artifact: stored }; });
    const service = new CrewReviewEvidenceService(
      {
        diff: async () => ({ diff: 'partial', truncated: true }),
        inspectBoundary: async () => boundary,
      } as never,
      { writeLog } as never, { listByRun: () => existing } as never,
    );
    await expect(service.ensureCurrentDiff(run as never)).rejects.toThrow('safe review artifact bound');
    await expect(service.ensureCurrentDiff(run as never)).rejects.toThrow('safe review artifact bound');
    expect(writeLog).toHaveBeenCalled();
    expect(writeLog).toHaveBeenCalledTimes(1);
  });

  it('never persists a diff when the exact workspace changes during generation', async () => {
    const inspectBoundary = jest.fn()
      .mockResolvedValueOnce(boundary)
      .mockResolvedValueOnce({ ...boundary, fullHead: 'c'.repeat(40) });
    const writeLog = jest.fn();
    const service = new CrewReviewEvidenceService(
      { inspectBoundary, diff: async () => ({ diff: 'poisoned', truncated: false }) } as never,
      { writeLog } as never, { listByRun: () => [] } as never,
    );
    await expect(service.ensureCurrentDiff(run as never)).rejects.toThrow('boundary is stale');
    expect(writeLog).not.toHaveBeenCalled();
  });
});
