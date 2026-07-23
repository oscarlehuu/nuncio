import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import { ForgeRepoController } from '../../../src/forges/api/forge-repo.controller';
import type { ForgeRepoService } from '../../../src/forges/forges-repo.service';
import type { ProjectPullRequestsService } from '../../../src/forges/project-pull-requests.service';

const pullRequests = {
  aggregate: async () => ({
    available: false,
    provider: null,
    reason: 'no-forge-remote' as const,
    counts: { open: null, merged: null, closed: null },
    pullRequests: [],
  }),
} as unknown as ProjectPullRequestsService;

function makeSpy() {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    if (name.startsWith('merge') || name === 'mergePullRequest') {
      return Promise.resolve({ merged: true, sha: 'abc', message: 'merged' });
    }
    if (name === 'createIssue') {
      return Promise.resolve({
        number: 1,
        title: 'Bug',
        state: 'open',
        author: 'octo',
        labels: [],
        assignees: [],
        commentCount: 0,
        updatedAt: '2024-01-01T00:00:00Z',
        url: 'https://example/issues/1',
      });
    }
    if (name === 'getPullRequestDetail') {
      return Promise.resolve({
        number: 12,
        url: 'https://example/pr/12',
        state: 'open',
        title: 'PR',
        body: '',
        author: 'octo',
        draft: false,
        sourceBranch: 'feature',
        targetBranch: 'main',
        mergeable: 'mergeable',
        reviewDecision: null,
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        checks: [],
      });
    }
    if (name === 'getIssue') {
      return Promise.resolve({
        number: 30,
        title: 'Issue',
        state: 'open',
        author: 'octo',
        labels: [],
        assignees: [],
        commentCount: 0,
        updatedAt: '2024-01-01T00:00:00Z',
        url: 'https://example/issues/30',
        body: '',
        comments: [],
      });
    }
    if (name === 'getJobLog') {
      return Promise.resolve({ log: 'log', truncated: false });
    }
    if (name === 'capabilities') {
      return Promise.resolve({
        provider: 'github',
        connected: true,
        authMethod: 'cli' as const,
        requestChanges: true,
        rebaseMerge: true,
        mergeWhenChecksPass: false,
        resolveThreads: true,
        updateBranch: true,
        rerunFailedOnly: false,
        listRepositories: false,
      });
    }
    return Promise.resolve([]);
  };
  const forge = {
    capabilities: record('capabilities'),
    listPullRequests: record('listPullRequests'),
    getPullRequestDetail: record('getPullRequestDetail'),
    listPullRequestFiles: record('listPullRequestFiles'),
    listReviewThreads: record('listReviewThreads'),
    listPullRequestComments: record('listPullRequestComments'),
    replyToThread: record('replyToThread'),
    resolveThread: record('resolveThread'),
    submitReview: record('submitReview'),
    addPullRequestComment: record('addPullRequestComment'),
    mergePullRequest: record('mergePullRequest'),
    updatePullRequestState: record('updatePullRequestState'),
    updateBranch: record('updateBranch'),
    listWorkflowRuns: record('listWorkflowRuns'),
    getWorkflowRunJobs: record('getWorkflowRunJobs'),
    rerunWorkflowRun: record('rerunWorkflowRun'),
    cancelWorkflowRun: record('cancelWorkflowRun'),
    getJobLog: record('getJobLog'),
    listIssues: record('listIssues'),
    getIssue: record('getIssue'),
    addIssueComment: record('addIssueComment'),
    updateIssueState: record('updateIssueState'),
    createIssue: record('createIssue'),
  } as unknown as ForgeRepoService;
  return { forge, calls };
}

describe('ForgeRepoController', () => {
  const path = '/repos/demo';

  it('delegates capabilities and pull/issue/workflow routes to ForgeRepoService', async () => {
    const { forge, calls } = makeSpy();
    const controller = new ForgeRepoController(forge, pullRequests);

    await expect(controller.capabilities(path)).resolves.toEqual({
      provider: 'github',
      connected: true,
      authMethod: 'cli',
      requestChanges: true,
      rebaseMerge: true,
      mergeWhenChecksPass: false,
      resolveThreads: true,
      updateBranch: true,
      rerunFailedOnly: false,
      listRepositories: false,
    });
    expect(calls.capabilities).toEqual([[path]]);

    await expect(controller.listPulls(path, 'closed')).resolves.toEqual([]);
    expect(calls.listPullRequests).toEqual([[path, 'closed']]);

    await expect(controller.getPull(path, '12')).resolves.toMatchObject({ number: 12 });
    expect(calls.getPullRequestDetail).toEqual([[path, 12]]);

    await expect(controller.listPullFiles(path, '3')).resolves.toEqual([]);
    expect(calls.listPullRequestFiles).toEqual([[path, 3]]);

    await expect(controller.listThreads(path, '4')).resolves.toEqual([]);
    expect(calls.listReviewThreads).toEqual([[path, 4]]);

    await expect(controller.listPullComments(path, '4')).resolves.toEqual([]);
    expect(calls.listPullRequestComments).toEqual([[path, 4]]);

    await expect(controller.replyToThread(path, '5', 'thread-1', { body: ' hi ' })).resolves.toEqual({
      ok: true,
    });
    expect(calls.replyToThread).toEqual([[path, 5, 'thread-1', ' hi ']]);

    await expect(controller.resolveThread(path, '6', 'thread-2', { resolved: false })).resolves.toEqual({
      ok: true,
    });
    expect(calls.resolveThread).toEqual([[path, 6, 'thread-2', false]]);

    await expect(
      controller.submitReview(path, '7', { event: 'approve', body: 'lgtm' }),
    ).resolves.toEqual({ ok: true });
    expect(calls.submitReview).toEqual([[path, 7, { event: 'approve', body: 'lgtm' }]]);

    await expect(controller.addPullComment(path, '8', { body: 'note' })).resolves.toEqual({ ok: true });
    expect(calls.addPullRequestComment).toEqual([[path, 8, 'note']]);

    await expect(
      controller.mergePull(path, '9', {
        method: 'squash',
        deleteSourceBranch: true,
        mergeWhenChecksPass: true,
        commitTitle: 'title',
        commitMessage: 'msg',
      }),
    ).resolves.toEqual({ merged: true, sha: 'abc', message: 'merged' });
    expect(calls.mergePullRequest).toEqual([
      [
        path,
        9,
        {
          method: 'squash',
          deleteSourceBranch: true,
          mergeWhenChecksPass: true,
          commitTitle: 'title',
          commitMessage: 'msg',
        },
      ],
    ]);

    await expect(controller.updatePullState(path, '10', { state: 'closed' })).resolves.toEqual({
      ok: true,
    });
    expect(calls.updatePullRequestState).toEqual([[path, 10, 'closed']]);

    await expect(controller.updateBranch(path, '11')).resolves.toEqual({ ok: true });
    expect(calls.updateBranch).toEqual([[path, 11]]);

    await expect(controller.listRuns(path, ' main ')).resolves.toEqual([]);
    expect(calls.listWorkflowRuns).toEqual([[path, 'main']]);

    await expect(controller.listRunJobs(path, '22')).resolves.toEqual([]);
    expect(calls.getWorkflowRunJobs).toEqual([[path, 22]]);

    await expect(controller.rerunRun(path, '23', { failedOnly: true })).resolves.toEqual({ ok: true });
    expect(calls.rerunWorkflowRun).toEqual([[path, 23, true]]);

    await expect(controller.cancelRun(path, '24')).resolves.toEqual({ ok: true });
    expect(calls.cancelWorkflowRun).toEqual([[path, 24]]);

    await expect(controller.getJobLog(path, '25')).resolves.toEqual({ log: 'log', truncated: false });
    expect(calls.getJobLog).toEqual([[path, 25]]);

    await expect(controller.listIssues(path)).resolves.toEqual([]);
    expect(calls.listIssues).toEqual([[path, 'open']]);

    await expect(controller.getIssue(path, '30')).resolves.toMatchObject({ number: 30 });
    expect(calls.getIssue).toEqual([[path, 30]]);

    await expect(controller.addIssueComment(path, '31', { body: 'fix' })).resolves.toEqual({ ok: true });
    expect(calls.addIssueComment).toEqual([[path, 31, 'fix']]);

    await expect(controller.updateIssueState(path, '32', { state: 'open' })).resolves.toEqual({ ok: true });
    expect(calls.updateIssueState).toEqual([[path, 32, 'open']]);

    await expect(
      controller.createIssue(path, { title: 'Bug', body: 'details', labels: ['bug'] }),
    ).resolves.toEqual({
      number: 1,
      title: 'Bug',
      state: 'open',
      author: 'octo',
      labels: [],
      assignees: [],
      commentCount: 0,
      updatedAt: '2024-01-01T00:00:00Z',
      url: 'https://example/issues/1',
    });
    expect(calls.createIssue).toEqual([[path, { title: 'Bug', body: 'details', labels: ['bug'] }]]);
  });

  it('rejects invalid numeric path params', () => {
    const { forge } = makeSpy();
    const controller = new ForgeRepoController(forge, pullRequests);
    expect(() => controller.getPull(path, '0')).toThrow(BadRequestException);
    expect(() => controller.getPull(path, 'abc')).toThrow(BadRequestException);
  });

  it('rejects invalid state filters and open/closed transitions', async () => {
    const { forge } = makeSpy();
    const controller = new ForgeRepoController(forge, pullRequests);
    expect(() => controller.listPulls(path, 'merged')).toThrow(BadRequestException);
    await expect(controller.updatePullState(path, '1', { state: 'merged' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.updateIssueState(path, '1', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid review events and merge methods', async () => {
    const { forge } = makeSpy();
    const controller = new ForgeRepoController(forge, pullRequests);
    await expect(controller.submitReview(path, '1', { event: 'ship' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(() =>
      controller.mergePull(path, '1', { method: 'fast-forward' as never }),
    ).toThrow(BadRequestException);
  });
});
