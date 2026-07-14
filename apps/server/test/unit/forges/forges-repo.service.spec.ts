import { BadRequestException } from '@nestjs/common';
import { ForgeRepoService } from '../../../src/forges/forges-repo.service';
import type { ForgeRegistry } from '../../../src/forges/forges.registry';
import type { GitService } from '../../../src/git/git.service';
import type { ForgeProvider } from '../../../src/forges/forges.types';

function makeProvider(overrides: Partial<ForgeProvider> = {}): ForgeProvider {
  return {
    id: 'github',
    name: 'GitHub',
    isAvailable: async () => true,
    resolveAuth: async () => ({ token: 't', method: 'cli' as const }),
    capabilities: () => ({
      requestChanges: true,
      rebaseMerge: true,
      mergeWhenChecksPass: false,
      resolveThreads: true,
      updateBranch: true,
    }),
    listPullRequests: async () => [],
    getPullRequestDetail: async () => ({
      number: 1,
      url: 'u',
      state: 'open',
      title: 't',
      body: '',
      author: 'a',
      draft: false,
      sourceBranch: 'feature',
      targetBranch: 'main',
      mergeable: 'mergeable' as const,
      reviewDecision: null,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
    }),
    listChecks: async () => [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    ...overrides,
  } as ForgeProvider;
}

function makeService(provider: ForgeProvider, host = 'github.com') {
  const git = {
    remoteInfo: async (path: string) => {
      if (!path.startsWith('/')) throw new BadRequestException('not a repo');
      return { host, owner: 'octo', repo: 'repo' };
    },
  } as unknown as GitService;
  const registry = {
    get: (id: string) => {
      if (id !== provider.id) throw new BadRequestException(`Unknown forge provider ${id}`);
      return provider;
    },
    getAvailable: async (id: string) => {
      if (id !== provider.id) throw new BadRequestException(`provider ${id} not available`);
      return provider;
    },
  } as unknown as ForgeRegistry;
  return new ForgeRepoService(registry, git);
}

describe('ForgeRepoService', () => {
  it('rejects a missing path with a 400', async () => {
    const service = makeService(makeProvider());
    await expect(service.listPullRequests('', 'open')).rejects.toThrow('path query parameter');
    await expect(service.capabilities('  ')).rejects.toThrow('path query parameter');
  });

  it('capabilities reports connected + authMethod without requiring availability', async () => {
    const service = makeService(makeProvider());
    const caps = await service.capabilities('/some/repo');
    expect(caps).toMatchObject({
      provider: 'github',
      connected: true,
      authMethod: 'cli',
      requestChanges: true,
    });
  });

  it('capabilities reports connected:false when no auth resolves', async () => {
    const service = makeService(makeProvider({ resolveAuth: async () => null }));
    const caps = await service.capabilities('/some/repo');
    expect(caps.connected).toBe(false);
    expect(caps.authMethod).toBeNull();
  });

  it('routes gitlab-hosted repos to the gitlab provider id', async () => {
    const provider = makeProvider({ id: 'gitlab', name: 'GitLab' } as Partial<ForgeProvider>);
    const service = makeService(provider, 'gitlab.acme.dev');
    const caps = await service.capabilities('/some/repo');
    expect(caps.provider).toBe('gitlab');
  });

  it('getPullRequestDetail attaches checks for the source branch', async () => {
    const service = makeService(makeProvider());
    const detail = await service.getPullRequestDetail('/some/repo', 1);
    expect(detail.checks).toEqual([{ name: 'ci', status: 'completed', conclusion: 'success' }]);
  });

  it('rejects empty bodies on comment-like operations', async () => {
    const service = makeService(makeProvider());
    await expect(service.addIssueComment('/some/repo', 1, '  ')).rejects.toThrow('body is required');
    await expect(service.createIssue('/some/repo', { title: ' ', body: '' })).rejects.toThrow(
      'title is required',
    );
  });

  it('delegates pull, issue, and workflow operations to the resolved provider', async () => {
    const calls: string[] = [];
    const provider = makeProvider({
      listPullRequests: async () => [{ number: 2, title: 'PR', state: 'open' }],
      listPullRequestFiles: async () => [{ path: 'a.ts', status: 'modified' }],
      listReviewThreads: async () => [{ id: 't1', resolved: false }],
      replyToThread: async () => { calls.push('reply'); },
      resolveThread: async () => { calls.push('resolve'); },
      submitReview: async () => { calls.push('review'); },
      addComment: async () => { calls.push('pr-comment'); },
      mergePullRequest: async () => ({ merged: true, sha: 'abc' }),
      updatePullRequestState: async () => { calls.push('pr-state'); },
      updateBranch: async () => { calls.push('update-branch'); },
      listIssues: async () => [{ number: 3, title: 'Issue', state: 'open' }],
      getIssue: async () => ({ number: 3, title: 'Issue', state: 'open', body: '' }),
      addIssueComment: async () => { calls.push('issue-comment'); },
      updateIssueState: async () => { calls.push('issue-state'); },
      createIssue: async () => ({ number: 4, title: 'New', state: 'open' }),
      listWorkflowRuns: async () => [{ id: 9, status: 'completed' }],
      getWorkflowRunJobs: async () => [{ id: 10, name: 'build', status: 'completed' }],
      rerunWorkflowRun: async () => { calls.push('rerun'); },
      cancelWorkflowRun: async () => { calls.push('cancel'); },
      getJobLog: async () => ({ text: 'log output' }),
      getPullRequestDetail: async () => ({
        number: 1,
        url: 'u',
        state: 'open',
        title: 't',
        body: '',
        author: 'a',
        draft: false,
        sourceBranch: null,
        targetBranch: 'main',
        mergeable: 'mergeable' as const,
        reviewDecision: null,
        additions: 0,
        deletions: 0,
        changedFiles: 0,
      }),
    });
    const service = makeService(provider);

    await expect(service.listPullRequests('/some/repo', 'all')).resolves.toHaveLength(1);
    await expect(service.listPullRequestFiles('/some/repo', 1)).resolves.toHaveLength(1);
    await expect(service.listReviewThreads('/some/repo', 1)).resolves.toHaveLength(1);
    await service.replyToThread('/some/repo', 1, 'thread', 'hello');
    await service.resolveThread('/some/repo', 1, 'thread', true);
    await service.submitReview('/some/repo', 1, { event: 'comment', body: 'note' });
    await service.addPullRequestComment('/some/repo', 1, 'comment');
    await expect(service.mergePullRequest('/some/repo', 1, { method: 'merge' })).resolves.toEqual({
      merged: true,
      sha: 'abc',
    });
    await service.updatePullRequestState('/some/repo', 1, 'closed');
    await service.updateBranch('/some/repo', 1);
    await expect(service.listIssues('/some/repo', 'open')).resolves.toHaveLength(1);
    await expect(service.getIssue('/some/repo', 3)).resolves.toMatchObject({ number: 3 });
    await service.addIssueComment('/some/repo', 3, 'fix');
    await service.updateIssueState('/some/repo', 3, 'closed');
    await expect(service.createIssue('/some/repo', { title: 'Bug', body: 'x' })).resolves.toMatchObject({
      number: 4,
    });
    await expect(service.listWorkflowRuns('/some/repo', 'main')).resolves.toHaveLength(1);
    await expect(service.getWorkflowRunJobs('/some/repo', 9)).resolves.toHaveLength(1);
    await service.rerunWorkflowRun('/some/repo', 9, true);
    await service.cancelWorkflowRun('/some/repo', 9);
    await expect(service.getJobLog('/some/repo', 10)).resolves.toEqual({ text: 'log output' });
    expect(calls).toEqual([
      'reply',
      'resolve',
      'review',
      'pr-comment',
      'pr-state',
      'update-branch',
      'issue-comment',
      'issue-state',
      'rerun',
      'cancel',
    ]);
  });

  it('returns an empty checks array when listChecks fails or source branch is missing', async () => {
    const withBranch = makeProvider({
      listChecks: async () => { throw new Error('rate limited'); },
    });
    const serviceWithBranch = makeService(withBranch);
    const detail = await serviceWithBranch.getPullRequestDetail('/some/repo', 1);
    expect(detail.checks).toEqual([]);

    const noBranch = makeProvider({
      getPullRequestDetail: async () => ({
        number: 1,
        url: 'u',
        state: 'open',
        title: 't',
        body: '',
        author: 'a',
        draft: false,
        sourceBranch: null,
        targetBranch: 'main',
        mergeable: 'mergeable' as const,
        reviewDecision: null,
        additions: 0,
        deletions: 0,
        changedFiles: 0,
      }),
      listChecks: async () => [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    });
    const serviceNoBranch = makeService(noBranch);
    const noChecks = await serviceNoBranch.getPullRequestDetail('/some/repo', 1);
    expect(noChecks.checks).toEqual([]);
  });
});
