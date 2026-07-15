import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ForgesService } from '../../../src/forges/forges.service';

describe('POST /sessions/from-pr orchestration', () => {
  const path = '/projects/nuncio';
  let createCalls: Array<Record<string, unknown>>;
  let forgeStateUpdates: Array<{ id: string; state: Record<string, unknown> }>;
  let fetchedHeads: Array<{ path: string; provider: string; number: number }>;

  function makeService(projects = [{ path }], sameRepository = true) {
    createCalls = [];
    forgeStateUpdates = [];
    fetchedHeads = [];
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
    const registry = { getAvailable: async () => provider };
    const git = {
      listProjects: async () => projects,
      remoteInfo: async () => ({ host: 'github.com', owner: 'octo', repo: 'nuncio' }),
      fetchPullRequestHead: async (projectPath: string, providerId: string, number: number) => {
        fetchedHeads.push({ path: projectPath, provider: providerId, number });
        return 'refs/nuncio/pull-requests/github/42';
      },
    };
    const records = {
      updateForgeState: (id: string, state: Record<string, unknown>) => {
        forgeStateUpdates.push({ id, state });
      },
    };
    const sessionRunner = {
      create: async (input: Record<string, unknown>) => {
        createCalls.push(input);
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
    });
    expect(fetchedHeads).toEqual([{ path, provider: 'github', number: 42 }]);
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
});
