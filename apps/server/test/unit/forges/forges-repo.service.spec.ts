import { BadRequestException } from '@nestjs/common';
import { ForgeRepoService } from '../../../src/forges/forges-repo.service';
import type { ForgeRegistry } from '../../../src/forges/forges.registry';
import type { GitService } from '../../../src/git/git.service';
import type {
  ForgeIssueDetail,
  ForgeIssueSummary,
  ForgeJobLog,
  ForgeProvider,
  ForgePullRequestDetail,
  ForgePullRequestSummary,
  ForgeReviewThread,
  MergeResult,
} from '../../../src/forges/forges.types';

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
    const pullSummary: ForgePullRequestSummary = {
      number: 2,
      title: 'PR',
      state: 'open',
      draft: false,
      author: 'octo',
      sourceBranch: 'feature',
      targetBranch: 'main',
      url: 'https://example/pr/2',
      updatedAt: '2024-01-01T00:00:00Z',
      commentCount: null,
    };
    const issueSummary: ForgeIssueSummary = {
      number: 3,
      title: 'Issue',
      state: 'open',
      author: 'octo',
      labels: [],
      assignees: [],
      commentCount: 0,
      updatedAt: '2024-01-01T00:00:00Z',
      url: 'https://example/issues/3',
    };
    const issueDetail: ForgeIssueDetail = { ...issueSummary, body: '', comments: [] };
    const pullDetail: ForgePullRequestDetail = {
      number: 1,
      url: 'u',
      state: 'open',
      title: 't',
      body: '',
      author: 'a',
      draft: false,
      sourceBranch: 'feature',
      targetBranch: 'main',
      mergeable: 'mergeable',
      reviewDecision: null,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
    };
    const mergeResult: MergeResult = { merged: true, sha: 'abc', message: 'merged' };
    const jobLog: ForgeJobLog = { log: 'log output', truncated: false };
    const reviewThread: ForgeReviewThread = {
      id: 't1',
      replyTargetId: 'rt1',
      resolved: false,
      resolvable: true,
      path: null,
      line: null,
      outdated: false,
      comments: [],
    };
    const provider = makeProvider({
      listPullRequests: async () => [pullSummary],
      listPullRequestFiles: async () => [
        { path: 'a.ts', oldPath: null, status: 'modified', additions: 1, deletions: 0, patch: null },
      ],
      listReviewThreads: async () => [reviewThread],
      replyToThread: async () => { calls.push('reply'); },
      resolveThread: async () => { calls.push('resolve'); },
      submitReview: async () => { calls.push('review'); },
      addComment: async () => { calls.push('pr-comment'); },
      mergePullRequest: async () => mergeResult,
      updatePullRequestState: async () => { calls.push('pr-state'); },
      updateBranch: async () => { calls.push('update-branch'); },
      listIssues: async () => [issueSummary],
      getIssue: async () => issueDetail,
      addIssueComment: async () => { calls.push('issue-comment'); },
      updateIssueState: async () => { calls.push('issue-state'); },
      createIssue: async () => ({ ...issueSummary, number: 4, title: 'New' }),
      listWorkflowRuns: async () => [
        {
          id: 9,
          name: 'CI',
          runNumber: 1,
          status: 'completed',
          conclusion: 'success',
          branch: 'main',
          sha: 'abc',
          event: 'push',
          actor: 'octo',
          url: 'https://example/runs/9',
          createdAt: '2024-01-01T00:00:00Z',
          durationSeconds: 60,
        },
      ],
      getWorkflowRunJobs: async () => [
        {
          id: 10,
          name: 'build',
          status: 'completed',
          conclusion: 'success',
          startedAt: null,
          completedAt: null,
          steps: [],
        },
      ],
      rerunWorkflowRun: async () => { calls.push('rerun'); },
      cancelWorkflowRun: async () => { calls.push('cancel'); },
      getJobLog: async () => jobLog,
      getPullRequestDetail: async () => pullDetail,
    });
    const service = makeService(provider);

    await expect(service.listPullRequests('/some/repo', 'all')).resolves.toHaveLength(1);
    await expect(service.listPullRequestFiles('/some/repo', 1)).resolves.toHaveLength(1);
    await expect(service.listReviewThreads('/some/repo', 1)).resolves.toHaveLength(1);
    await service.replyToThread('/some/repo', 1, 'thread', 'hello');
    await service.resolveThread('/some/repo', 1, 'thread', true);
    await service.submitReview('/some/repo', 1, { event: 'comment', body: 'note' });
    await service.addPullRequestComment('/some/repo', 1, 'comment');
    await expect(service.mergePullRequest('/some/repo', 1, { method: 'merge' })).resolves.toEqual(
      mergeResult,
    );
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
    await expect(service.getJobLog('/some/repo', 10)).resolves.toEqual(jobLog);
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
        sourceBranch: '',
        targetBranch: 'main',
        mergeable: 'mergeable',
        reviewDecision: null,
        additions: 0,
        deletions: 0,
        changedFiles: 0,
      } satisfies ForgePullRequestDetail),
      listChecks: async () => [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    });
    const serviceNoBranch = makeService(noBranch);
    const noChecks = await serviceNoBranch.getPullRequestDetail('/some/repo', 1);
    expect(noChecks.checks).toEqual([]);
  });
});
