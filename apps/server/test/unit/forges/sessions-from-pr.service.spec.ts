import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ForgesService } from '../../../src/forges/forges.service';

describe('POST /sessions/from-pr orchestration', () => {
  const path = '/projects/nuncio';
  let createCalls: Array<Record<string, unknown>>;
  let forgeStateUpdates: Array<{ id: string; state: Record<string, unknown> }>;
  let fetchedHeads: Array<{ path: string; provider: string; number: number }>;
  let fetchedBranches: Array<{ path: string; branch: string }>;
  let releasedClaims: Array<{ path: string; number: number }>;
  let renewedClaims: number;

  function makeService(
    projects = [{ path }],
    sameRepository = true,
    claimResult: { status: 'claimed' } | { status: 'existing'; sessionId: string } | { status: 'pending' } = { status: 'claimed' },
    creationError?: Error,
    completionError?: Error,
    concurrentOwnerId?: string,
  ) {
    createCalls = [];
    forgeStateUpdates = [];
    fetchedHeads = [];
    fetchedBranches = [];
    releasedClaims = [];
    renewedClaims = 0;
    const provider = {
      id: 'github',
      getPullRequestDetail: async () => ({
        number: 42,
        title: 'Fix the race',
        body: 'Avoid duplicate dispatch.',
        url: 'https://github.com/octo/nuncio/pull/42',
        state: 'open',
        sourceBranch: 'feat/fix-race',
        sourceRepositoryMatchesTarget: sameRepository,
      }),
    };
    let createdOwnerId: string | null = null;
    const registry = { getAvailable: async () => provider };
    const git = {
      listProjects: async () => projects,
      remoteInfo: async () => ({ host: 'github.com', owner: 'octo', repo: 'nuncio' }),
      fetchPullRequestHead: async (projectPath: string, providerId: string, number: number) => {
        fetchedHeads.push({ path: projectPath, provider: providerId, number });
        return 'refs/nuncio/pull-requests/github/42';
      },
      fetchRemoteBranch: async (projectPath: string, branch: string) => {
        fetchedBranches.push({ path: projectPath, branch });
        return `origin/${branch}`;
      },
    };
    const records = {
      claimPullRequestAdoption: () => createdOwnerId
        ? { status: 'existing' as const, sessionId: createdOwnerId }
        : claimResult,
      findByProjectPullRequest: () => {
        const id = createdOwnerId ?? concurrentOwnerId;
        return id ? { id } : null;
      },
      renewPullRequestAdoption: () => {
        renewedClaims += 1;
        return true;
      },
      completePullRequestAdoption: (
        _path: string,
        number: number,
        _token: string,
        id: string,
        state: Record<string, unknown>,
      ) => {
        if (completionError) throw completionError;
        forgeStateUpdates.push({ id, state: { ...state, pullRequestNumber: number } });
      },
      releasePullRequestAdoption: (projectPath: string, number: number) => {
        releasedClaims.push({ path: projectPath, number });
      },
      updateForgeState: (id: string, state: Record<string, unknown>) => {
        forgeStateUpdates.push({ id, state });
      },
    };
    const sessionRunner = {
      create: async (input: Record<string, unknown>) => {
        if (creationError) throw creationError;
        createCalls.push(input);
        createdOwnerId = 'session-from-pr';
        return { id: 'session-from-pr' };
      },
    };
    return new (ForgesService as never as new (...args: never[]) => ForgesService)(
      registry as never,
      git as never,
      records as never,
      sessionRunner as never,
    );
  }

  it('creates a worktree session from the PR head branch and persists ownership', async () => {
    const service = makeService();
    const result = await (service as never as {
      createSessionFromPullRequest(path: string, number: number): Promise<{ sessionId: string }>;
    }).createSessionFromPullRequest(path, 42);

    expect(result).toEqual({ sessionId: 'session-from-pr' });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      projectPath: path,
      baseBranch: 'refs/nuncio/pull-requests/github/42',
      useWorktree: true,
      pushBranch: 'feat/fix-race',
      upstreamBranch: 'origin/feat/fix-race',
      forgeProvider: 'github',
      pullRequestNumber: 42,
      pullRequestState: 'open',
    });
    expect(fetchedHeads).toEqual([{ path, provider: 'github', number: 42 }]);
    expect(fetchedBranches).toEqual([{ path, branch: 'feat/fix-race' }]);
    expect(renewedClaims).toBeGreaterThan(0);
    expect(String(createCalls[0].prompt)).toContain('Fix the race');
    expect(String(createCalls[0].prompt)).toContain('Avoid duplicate dispatch.');
    expect(String(createCalls[0].prompt)).toContain('https://github.com/octo/nuncio/pull/42');
    expect(forgeStateUpdates).toContainEqual({
      id: 'session-from-pr',
      state: expect.objectContaining({ forgeProvider: 'github', pullRequestNumber: 42 }),
    });
  });

  it('rejects a path that is not a known local project', async () => {
    const service = makeService([]);
    await expect(
      (service as never as {
        createSessionFromPullRequest(path: string, number: number): Promise<{ sessionId: string }>;
      }).createSessionFromPullRequest('/projects/missing', 42),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(createCalls).toHaveLength(0);
  });

  it('rejects fork pull requests instead of pushing their branch to the base origin', async () => {
    const service = makeService([{ path }], false);
    await expect(
      (service as never as {
        createSessionFromPullRequest(path: string, number: number): Promise<{ sessionId: string }>;
      }).createSessionFromPullRequest(path, 42),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createCalls).toHaveLength(0);
    expect(fetchedHeads).toHaveLength(0);
  });

  it('returns the existing active owner without creating another worktree', async () => {
    const service = makeService([{ path }], true, {
      status: 'existing',
      sessionId: 'existing-owner',
    });

    await expect((service as never as {
      createSessionFromPullRequest(path: string, number: number): Promise<{ sessionId: string }>;
    }).createSessionFromPullRequest(path, 42)).resolves.toEqual({ sessionId: 'existing-owner' });
    expect(createCalls).toHaveLength(0);
    expect(fetchedHeads).toHaveLength(0);
  });

  it('rejects a concurrent adoption while its SQLite claim is pending', async () => {
    const service = makeService([{ path }], true, { status: 'pending' });

    await expect((service as never as {
      createSessionFromPullRequest(path: string, number: number): Promise<{ sessionId: string }>;
    }).createSessionFromPullRequest(path, 42)).rejects.toBeInstanceOf(ConflictException);
    expect(createCalls).toHaveLength(0);
  });

  it('releases its pending claim when session creation fails', async () => {
    const service = makeService(
      [{ path }],
      true,
      { status: 'claimed' },
      new Error('worktree creation failed'),
    );

    await expect((service as never as {
      createSessionFromPullRequest(path: string, number: number): Promise<{ sessionId: string }>;
    }).createSessionFromPullRequest(path, 42)).rejects.toThrow('worktree creation failed');
    expect(releasedClaims).toEqual([{ path, number: 42 }]);
  });

  it('returns the inserted owner if claim finalization fails after session creation', async () => {
    const service = makeService(
      [{ path }],
      true,
      { status: 'claimed' },
      undefined,
      new Error('claim completion failed'),
    );

    await expect((service as never as {
      createSessionFromPullRequest(path: string, number: number): Promise<{ sessionId: string }>;
    }).createSessionFromPullRequest(path, 42)).resolves.toEqual({ sessionId: 'session-from-pr' });
    await expect((service as never as {
      createSessionFromPullRequest(path: string, number: number): Promise<{ sessionId: string }>;
    }).createSessionFromPullRequest(path, 42)).resolves.toEqual({ sessionId: 'session-from-pr' });
    expect(createCalls).toHaveLength(1);
  });

  it('returns the winning owner when a stale claimant loses the session insert race', async () => {
    const service = makeService(
      [{ path }],
      true,
      { status: 'claimed' },
      new Error('UNIQUE constraint failed: sessions.project_path, sessions.pull_request_number'),
      undefined,
      'winning-owner',
    );

    await expect((service as never as {
      createSessionFromPullRequest(path: string, number: number): Promise<{ sessionId: string }>;
    }).createSessionFromPullRequest(path, 42)).resolves.toEqual({ sessionId: 'winning-owner' });
    expect(releasedClaims).toEqual([{ path, number: 42 }]);
  });
});
