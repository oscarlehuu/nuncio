import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { CrewTaskDetail } from './crew-task-detail';
import {
  createCrewSuccessorRun,
  fetchCrewRun,
  fetchCrewTask,
  type CrewMemberResult,
  type CrewMemberResultDto,
  type CrewMemberResultPhase,
  type CrewRunDetailDto,
} from '@nuncio/core/crew-api';

vi.mock('@nuncio/core/crew-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nuncio/core/crew-api')>()),
  fetchCrewRun: vi.fn(),
  fetchCrewRunEvents: vi.fn().mockResolvedValue({ events: [], nextSince: 4 }),
  fetchCrewTask: vi.fn(),
  commandCrewRun: vi.fn(),
  createCrewSuccessorRun: vi.fn(),
}));

const snapshot = {
  presetId: 'quality' as const, sourceProfileId: 'p1', sourceProfileRevision: 3,
  bindings: { foreman: { provider: 'claude', model: 'fable', label: 'Fable' }, builder: { provider: 'codex', model: 'sol', label: 'Sol' }, reviewer: { provider: 'claude', model: 'opus', label: 'Opus' } },
  tester: { kind: 'nuncio' as const, runtimePolicy: 'read-only' as const },
  policy: { verifyCommand: 'bun test', maxVerifyRetries: 2, maxReviewRetries: 2, strictFreshFinalReviewer: true }, resolvedAt: 1,
};
const run = {
  id: 'r1', taskId: 't1', priorRunId: null, phase: 'VERIFY' as const, status: 'RUNNING' as const, outcome: null,
  blockedReason: null, profileSnapshot: snapshot, context: {}, contextRevision: 1, revision: 4,
  projectPath: '/repo', baseBranch: 'main', worktreePath: '/work', branch: 'crew', workspaceHead: 'a'.repeat(40),
  verifyRetriesUsed: 1, reviewRetriesUsed: 0, maxVerifyRetries: 2, maxReviewRetries: 2, verifyExtraRounds: 0, reviewExtraRounds: 0,
  createdAt: 1, updatedAt: 2, results: [], artifacts: [],
  members: [{ id: 'm1', role: 'builder' as const, label: 'Sol', provider: 'codex', model: 'sol', sessionId: 's1', status: 'idle' }],
  gates: [{ kind: 'verify' as const, status: 'passed' as const, workspaceHead: 'b'.repeat(40), warnings: [], artifactId: 'a1' }],
};
const completedRun = {
  ...run,
  id: 'r0',
  phase: 'DONE' as const,
  status: 'TERMINAL' as const,
  outcome: 'SUCCEEDED' as const,
  createdAt: 0,
  updatedAt: 1,
};

describe('CrewTaskDetail', () => {
  beforeEach(() => {
    vi.mocked(createCrewSuccessorRun).mockReset();
    vi.mocked(fetchCrewTask).mockReset().mockResolvedValue({ task: { id: 't1', objective: 'Ship Crew', projectPath: '/repo', baseBranch: 'main', createdAt: 1, updatedAt: 2 }, runs: [run] });
    vi.mocked(fetchCrewRun).mockReset().mockResolvedValue(run);
  });

  it('renders fixed progress, tuple/round summary, members, and stale evidence without transcripts', async () => {
    render(<MemoryRouter><CrewTaskDetail taskId="t1" /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Ship Crew' })).toBeInTheDocument();
    expect(screen.getByText(/verify · running · nuncio tester · round 2\/3/i)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: /crew run progress/i }).children).toHaveLength(6);
    expect(screen.getByText('Verify').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('link', { name: /open sol member session/i })).toHaveAttribute('href', '/session/s1');
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
    expect(screen.queryByText(/transcript|reasoning/i)).not.toBeInTheDocument();
  });

  it('wraps the run title and shows a human profile revision without the raw snapshot id', async () => {
    render(<MemoryRouter><CrewTaskDetail taskId="t1" /></MemoryRouter>);
    const heading = await screen.findByRole('heading', { name: 'Ship Crew' });
    expect(heading.className).toMatch(/line-clamp-2/);
    expect(heading.className).not.toMatch(/\btruncate\b/);
    expect(screen.getByText(/profile revision 3/i)).toBeInTheDocument();
    expect(screen.queryByText(/\bp1\b/)).toBeNull();
  });

  it('loads the requested immutable run and exposes every run in task history', async () => {
    vi.mocked(fetchCrewTask).mockResolvedValue({
      task: { id: 't1', objective: 'Ship Crew', projectPath: '/repo', baseBranch: 'main', createdAt: 1, updatedAt: 2 },
      runs: [completedRun, run],
    });
    vi.mocked(fetchCrewRun).mockImplementation(async (id) => id === 'r0' ? completedRun : run);

    render(<MemoryRouter><CrewTaskDetail taskId="t1" runId="r0" /></MemoryRouter>);

    expect(await screen.findByRole('navigation', { name: 'Crew run history' })).toBeInTheDocument();
    expect(fetchCrewRun).toHaveBeenCalledWith('r0');
    expect(screen.getByRole('link', { name: /Run 1.*Succeeded/i })).toHaveAttribute(
      'href',
      '/crew/t1?run=r0',
    );
    expect(screen.getByRole('link', { name: /Run 1.*Succeeded/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Run 1.*Succeeded/i })).toHaveClass('min-h-11');
    expect(screen.getByRole('link', { name: /Run 2.*Running/i })).toHaveAttribute(
      'href',
      '/crew/t1?run=r1',
    );
  });

  it('ignores an older detail response after a newer run selection has loaded', async () => {
    const oldDetail = deferred<CrewRunDetailDto>();
    const newDetail = deferred<CrewRunDetailDto>();
    vi.mocked(fetchCrewTask).mockResolvedValue({
      task: { id: 't1', objective: 'Ship Crew', projectPath: '/repo', baseBranch: 'main', createdAt: 1, updatedAt: 2 },
      runs: [completedRun, run],
    });
    vi.mocked(fetchCrewRun).mockImplementation((id) => id === 'r0' ? oldDetail.promise : newDetail.promise);

    const rendered = render(
      <MemoryRouter><CrewTaskDetail taskId="t1" runId="r0" /></MemoryRouter>,
    );
    await waitFor(() => expect(fetchCrewRun).toHaveBeenCalledWith('r0'));
    rendered.rerender(
      <MemoryRouter><CrewTaskDetail taskId="t1" runId="r1" /></MemoryRouter>,
    );
    await waitFor(() => expect(fetchCrewRun).toHaveBeenCalledWith('r1'));

    newDetail.resolve(run);
    expect(await screen.findByText('Verify · Running · Nuncio Tester · round 2/3')).toBeInTheDocument();
    oldDetail.resolve(completedRun);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Run 2.*Running/i })).toHaveAttribute(
        'aria-current',
        'page',
      );
    });
    expect(screen.getByText('Verify · Running · Nuncio Tester · round 2/3')).toBeInTheDocument();
  });

  it('replaces the immutable prior-run URL with the returned successor run', async () => {
    vi.mocked(fetchCrewTask).mockResolvedValue({
      task: { id: 't1', objective: 'Ship Crew', projectPath: '/repo', baseBranch: 'main', createdAt: 1, updatedAt: 2 },
      runs: [completedRun],
    });
    vi.mocked(fetchCrewRun).mockResolvedValue(completedRun);
    vi.mocked(createCrewSuccessorRun).mockResolvedValue({
      task: { id: 't1', objective: 'Ship Crew', projectPath: '/repo', baseBranch: 'main', createdAt: 1, updatedAt: 3 },
      run: { ...run, id: 'r2', priorRunId: 'r0', phase: 'PLAN', status: 'QUEUED', outcome: null, updatedAt: 3 },
    });

    render(
      <MemoryRouter initialEntries={['/crew/t1?run=r0']}>
        <CrewTaskDetail taskId="t1" runId="r0" />
        <LocationProbe />
      </MemoryRouter>,
    );
    await userEvent.type(await screen.findByRole('textbox', { name: 'Requested change' }), 'Add polish');
    await userEvent.click(screen.getByRole('button', { name: 'Request a change' }));

    expect(createCrewSuccessorRun).toHaveBeenCalledWith('t1', {
      changeRequest: 'Add polish',
      expectedBaseHead: 'a'.repeat(40),
      priorRunId: 'r0',
      expectedRevision: 4,
      profileId: 'p1',
    });
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/crew/t1?run=r2'));
    expect(fetchCrewRun).toHaveBeenCalledTimes(1);
  });

  it('renders the latest synthesis and nonblocking review evidence without raw paths', async () => {
    const outcomeRun = {
      ...completedRun,
      results: [
        resultRow('old-synthesis', 'SYNTHESIZE', 1, {
          kind: 'synthesis', summary: 'Old summary', verification: 'Old checks',
          remainingRisks: ['Old risk'], workspaceHead: 'head-1',
        }),
        resultRow('review', 'REVIEW', 2, {
          kind: 'review', summary: 'Reviewed', workspaceHead: 'head-2',
          findings: [
            { severity: 'blocker', title: 'Resolved blocker', body: 'Do not show this.' },
            {
              severity: 'warning', title: 'Cache follow-up', body: 'Watch the cold-cache path.',
              file: '/private/repo/cache.ts', line: 22,
            },
          ],
        }),
        resultRow('latest-synthesis', 'SYNTHESIZE', 3, {
          kind: 'synthesis', summary: 'Crew shipped the cache.',
          verification: 'bun run gate passed at head-2',
          remainingRisks: ['Cold-cache latency'], workspaceHead: 'head-2',
        }),
      ],
      artifacts: [{ relativeStoragePath: 'crew/run-1/raw-verify.log' }],
    } as unknown as CrewRunDetailDto;
    vi.mocked(fetchCrewTask).mockResolvedValue({
      task: { id: 't1', objective: 'Ship Crew', projectPath: '/repo', baseBranch: 'main', createdAt: 1, updatedAt: 2 },
      runs: [outcomeRun],
    });
    vi.mocked(fetchCrewRun).mockResolvedValue(outcomeRun);

    render(<MemoryRouter><CrewTaskDetail taskId="t1" /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Outcome' })).toBeInTheDocument();
    expect(screen.getByText('Crew shipped the cache.')).toBeInTheDocument();
    expect(screen.getByText('Foreman verification summary')).toBeInTheDocument();
    expect(screen.queryByText('Deterministic verification')).toBeNull();
    expect(screen.getByText('bun run gate passed at head-2')).toBeInTheDocument();
    expect(screen.getByText('Cold-cache latency')).toBeInTheDocument();
    expect(screen.getByText('Cache follow-up')).toBeInTheDocument();
    expect(screen.getByText('Watch the cold-cache path.')).toBeInTheDocument();
    expect(screen.queryByText('Old summary')).toBeNull();
    expect(screen.queryByText('Resolved blocker')).toBeNull();
    expect(screen.queryByText(/raw-verify\.log|private\/repo\/cache\.ts/)).toBeNull();
  });

  it('warns when a successful terminal run has no synthesis evidence', async () => {
    vi.mocked(fetchCrewTask).mockResolvedValue({
      task: { id: 't1', objective: 'Ship Crew', projectPath: '/repo', baseBranch: 'main', createdAt: 1, updatedAt: 2 },
      runs: [completedRun],
    });
    vi.mocked(fetchCrewRun).mockResolvedValue(completedRun);

    render(<MemoryRouter><CrewTaskDetail taskId="t1" /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent(/outcome evidence unavailable/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/incomplete evidence/i);
  });

  it('offers current verify/diff artifacts and explains the latest blocking review finding', async () => {
    const evidenceRun = {
      ...run,
      status: 'BLOCKED_USER' as const,
      blockedReason: 'review_round_cap' as const,
      workspaceHead: 'head-2',
      gates: [
        { kind: 'verify' as const, status: 'passed' as const, workspaceHead: 'head-2', warnings: [], artifactId: 'verify-1' },
        { kind: 'review' as const, status: 'changes_requested' as const, workspaceHead: 'head-2', warnings: [], artifactId: null },
      ],
      artifacts: [
        publicArtifact('verify-1', 'verify-log', 2),
        publicArtifact('diff-1', 'workspace-diff', 3),
      ],
      results: [
        resultRow('review-old', 'REVIEW', 1, {
          kind: 'review', summary: 'old', workspaceHead: 'head-2',
          findings: [{ severity: 'blocker', title: 'Old blocker', body: 'Old body' }],
        }),
        resultRow('review-new', 'REVIEW', 2, {
          kind: 'review', summary: 'new', workspaceHead: 'head-2',
          findings: [{
            severity: 'blocker', title: 'Retry boundary', body: 'Handle the final retry.',
            file: '/private/retry.ts', line: 4,
          }],
        }),
      ],
    } as unknown as CrewRunDetailDto;
    vi.mocked(fetchCrewTask).mockResolvedValue({
      task: { id: 't1', objective: 'Ship Crew', projectPath: '/repo', baseBranch: 'main', createdAt: 1, updatedAt: 2 },
      runs: [evidenceRun],
    });
    vi.mocked(fetchCrewRun).mockResolvedValue(evidenceRun);

    render(<MemoryRouter><CrewTaskDetail taskId="t1" /></MemoryRouter>);

    expect(await screen.findByRole('button', { name: 'Open verify log' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open workspace diff' })).toBeInTheDocument();
    expect(screen.getByText('Retry boundary')).toBeInTheDocument();
    expect(screen.getByText('Handle the final retry.')).toBeInTheDocument();
    expect(screen.queryByText('Old blocker')).toBeNull();
    expect(screen.queryByText(/private\/retry|command|cwd|storage/i)).toBeNull();
  });
});

function publicArtifact(id: string, kind: string, createdAt: number) {
  const metadata = kind === 'verify-log'
    ? { workspaceHead: 'head-2', passed: true, exitCode: 0, durationMs: 1, timedOut: false, outputOverflow: false, postBoundaryOk: true }
    : { workspaceHead: 'head-2', baseHead: 'base-1', truncated: false };
  return {
    id, runId: 'r1', kind, sha256: 'a'.repeat(64), byteCount: 10,
    metadata, retentionState: 'retained', createdAt,
  };
}

function resultRow(
  id: string,
  phase: CrewMemberResultPhase,
  attempt: number,
  result: CrewMemberResult,
): CrewMemberResultDto {
  return {
    id, runId: 'r0', memberSessionId: `member-${id}`, phase, attempt,
    result, basedOnContextRevision: 1, workspaceHead: 'head-2', createdAt: attempt,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
