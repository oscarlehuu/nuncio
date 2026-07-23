import {
  bucketPullRequests,
  ProjectPullRequestsService,
} from '../../../src/forges/project-pull-requests.service';
import type { ForgeRepoService } from '../../../src/forges/forges-repo.service';
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
    listPullRequests: async () => [],
    ...repoOverrides,
  } as unknown as ForgeRepoService;
  const sessions = {
    findByProjectPullRequest: () => null,
    ...sessionOverrides,
  } as unknown as SessionsRepository;
  return new ProjectPullRequestsService(forgeRepo, sessions);
}

describe('ProjectPullRequestsService.aggregate', () => {
  it('aggregates open/merged/closed and links known sessions', async () => {
    const service = makeService(
      {
        listPullRequests: async () => [
          summary({ number: 7, state: 'open', sourceBranch: 'feat-a' }),
          summary({ number: 8, state: 'merged' }),
          summary({ number: 9, state: 'closed' }),
        ],
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
    const linked = result.pullRequests.find((pr) => pr.number === 7);
    expect(linked?.sessionId).toBe('sess-7');
    expect(result.pullRequests.find((pr) => pr.number === 8)?.sessionId).toBeNull();
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
      listPullRequests: async () => {
        throw new Error('should not be called when unauthenticated');
      },
    });

    const result = await service.aggregate('/repos/app');
    expect(result.available).toBe(false);
    expect(result.reason).toBe('unavailable');
    expect(result.provider).toBe('github');
    expect(result.counts).toEqual({ open: null, merged: null, closed: null });
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
      listPullRequests: async () => {
        calls += 1;
        return [summary({ number: 1, state: 'open' })];
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
