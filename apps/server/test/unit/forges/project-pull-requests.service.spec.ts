import {
  bucketPullRequests,
  ProjectPullRequestsService,
} from '../../../src/forges/project-pull-requests.service';
import type { ForgeRepoService } from '../../../src/forges/forges-repo.service';
import type { GitService } from '../../../src/git/git.service';
import type { RepoIdentity } from '../../../src/git/repo-identity';
import type { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import type { ForgePullRequestSummary } from '../../../src/forges/forges.types';

function summary(overrides: Partial<ForgePullRequestSummary>): ForgePullRequestSummary {
  return {
    number: 1,
    title: 'PR',
    state: 'open',
    draft: false,
    author: 'octo',
    sourceBranch: 'feature',
    targetBranch: 'main',
    url: 'https://example/pr/1',
    updatedAt: '',
    commentCount: null,
    ...overrides,
  };
}

/** A repo identity keyed on repoRoot so worktree/main paths of one repo collapse. */
function repoIdentity(id: string): RepoIdentity {
  return { kind: 'repo', id, repoRoot: id, remoteUrl: null, isWorktree: false };
}

describe('bucketPullRequests', () => {
  it('buckets a mixed set into open / merged / closed', () => {
    const counts = bucketPullRequests([
      summary({ number: 1, state: 'open' }),
      summary({ number: 2, state: 'open' }),
      summary({ number: 3, state: 'merged' }),
      summary({ number: 4, state: 'closed' }),
      summary({ number: 5, state: 'merged' }),
    ]);
    expect(counts).toEqual({ open: 2, merged: 2, closed: 1 });
  });

  it('returns all-zero for an empty set (still honest counts)', () => {
    expect(bucketPullRequests([])).toEqual({ open: 0, merged: 0, closed: 0 });
  });
});

function makeService(
  repoOverrides: Partial<ForgeRepoService>,
  sessionOverrides: Partial<SessionsRepository> = {},
  gitOverrides: Partial<GitService> = {},
) {
  const forgeRepo = {
    capabilities: async () => ({
      provider: 'github',
      connected: true,
      authMethod: 'cli' as const,
      requestChanges: true,
      rebaseMerge: true,
      mergeWhenChecksPass: false,
      resolveThreads: true,
      updateBranch: true,
      rerunFailedOnly: true,
      listRepositories: true,
    }),
    listPullRequestsPaged: async () => ({ pullRequests: [], capped: false }),
    ...repoOverrides,
  } as unknown as ForgeRepoService;
  const sessions = {
    findByProjectPullRequest: () => null,
    findAllByPullRequestNumber: () => [],
    ...sessionOverrides,
  } as unknown as SessionsRepository;
  const git = {
    resolveRepoIdentity: async (path: string) => repoIdentity(path),
    ...gitOverrides,
  } as unknown as GitService;
  return new ProjectPullRequestsService(forgeRepo, sessions, git);
}

describe('ProjectPullRequestsService.aggregate', () => {
  it('aggregates open/merged/closed and links known sessions', async () => {
    const service = makeService(
      {
        listPullRequestsPaged: async () => ({
          pullRequests: [
            summary({ number: 7, state: 'open', sourceBranch: 'feat-a' }),
            summary({ number: 8, state: 'merged' }),
            summary({ number: 9, state: 'closed' }),
          ],
          capped: false,
        }),
      },
      {
        findByProjectPullRequest: ((_path: string, number: number) =>
          number === 7 ? ({ id: 'sess-7' } as never) : null) as never,
      },
    );

    const result = await service.aggregate('/repos/app');
    expect(result.available).toBe(true);
    expect(result.provider).toBe('github');
    expect(result.counts).toEqual({ open: 1, merged: 1, closed: 1 });
    expect(result.capped).toBe(false);
    const linked = result.pullRequests.find((pr) => pr.number === 7);
    expect(linked?.sessionId).toBe('sess-7');
    expect(result.pullRequests.find((pr) => pr.number === 8)?.sessionId).toBeNull();
  });

  it('surfaces capped=true when the forge paging cap was hit (count is a floor)', async () => {
    const service = makeService({
      listPullRequestsPaged: async () => ({
        pullRequests: [summary({ number: 1, state: 'open' })],
        capped: true,
      }),
    });

    const result = await service.aggregate('/repos/app');
    expect(result.available).toBe(true);
    expect(result.capped).toBe(true);
  });

  it('links a session whose projectPath is a linked worktree of the same repo', async () => {
    // The dashboard is viewed at the main checkout; the owning session was opened
    // in a linked worktree, so its stored project_path differs from the query
    // path but resolves to the same repo identity.
    const service = makeService(
      {
        listPullRequestsPaged: async () => ({
          pullRequests: [summary({ number: 42, state: 'open' })],
          capped: false,
        }),
      },
      {
        // No exact project_path match for the main checkout.
        findByProjectPullRequest: (() => null) as never,
        findAllByPullRequestNumber: ((number: number) =>
          number === 42
            ? [{ id: 'sess-wt', projectPath: '/work/wt-42' } as never]
            : []) as never,
      },
      {
        // Both the main checkout and the worktree resolve to one repo identity.
        resolveRepoIdentity: (async (path: string) =>
          path === '/repos/app' || path === '/work/wt-42'
            ? repoIdentity('remote:github.com/octo/app')
            : repoIdentity(path)) as never,
      },
    );

    const result = await service.aggregate('/repos/app');
    expect(result.pullRequests.find((pr) => pr.number === 42)?.sessionId).toBe('sess-wt');
  });

  it('does not link a same-PR-number session that belongs to a different repo', async () => {
    const service = makeService(
      {
        listPullRequestsPaged: async () => ({
          pullRequests: [summary({ number: 42, state: 'open' })],
          capped: false,
        }),
      },
      {
        findByProjectPullRequest: (() => null) as never,
        findAllByPullRequestNumber: ((number: number) =>
          number === 42
            ? [{ id: 'sess-other', projectPath: '/repos/other' } as never]
            : []) as never,
      },
      {
        resolveRepoIdentity: (async (path: string) =>
          repoIdentity(path === '/repos/app' ? 'id-app' : 'id-other')) as never,
      },
    );

    const result = await service.aggregate('/repos/app');
    expect(result.pullRequests.find((pr) => pr.number === 42)?.sessionId).toBeNull();
  });

  it('yields "unavailable" (never an auth prompt) when the forge is unauthenticated', async () => {
    const service = makeService({
      capabilities: async () => ({
        provider: 'github',
        connected: false,
        authMethod: null,
        requestChanges: false,
        rebaseMerge: false,
        mergeWhenChecksPass: false,
        resolveThreads: false,
        updateBranch: false,
        rerunFailedOnly: false,
        listRepositories: false,
      }),
      listPullRequestsPaged: async () => {
        throw new Error('should not be called when unauthenticated');
      },
    });

    const result = await service.aggregate('/repos/app');
    expect(result.available).toBe(false);
    expect(result.reason).toBe('unavailable');
    expect(result.provider).toBe('github');
    expect(result.counts).toEqual({ open: null, merged: null, closed: null });
    expect(result.capped).toBe(false);
    expect(result.pullRequests).toEqual([]);
  });

  it('reports no forge remote for a non-forge project', async () => {
    const service = makeService({
      capabilities: async () => {
        throw new Error('Failed to read origin remote');
      },
    });
    const result = await service.aggregate('/loose/folder');
    expect(result.available).toBe(false);
    expect(result.reason).toBe('no-forge-remote');
    expect(result.provider).toBeNull();
  });

  it('caches within the TTL and refetches after it expires', async () => {
    let calls = 0;
    const service = makeService({
      listPullRequestsPaged: async () => {
        calls += 1;
        return { pullRequests: [summary({ number: 1, state: 'open' })], capped: false };
      },
    });
    let now = 1_000;
    service.setClock(() => now);

    await service.aggregate('/repos/app');
    await service.aggregate('/repos/app');
    expect(calls).toBe(1);

    now += 60_000;
    await service.aggregate('/repos/app');
    expect(calls).toBe(2);
  });
});
