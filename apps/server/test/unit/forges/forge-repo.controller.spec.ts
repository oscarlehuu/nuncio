import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import { ForgeRepoController } from '../../../src/forges/api/forge-repo.controller';

type ForgeRepoSpy = {
  calls: Record<string, unknown[][]>;
} & Record<string, (...args: unknown[]) => unknown>;

function makeSpy(): ForgeRepoSpy {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return name.startsWith('merge') || name === 'createIssue'
      ? { number: 1, url: 'https://example/pr/1' }
      : name === 'getJobLog'
        ? { text: 'log' }
        : name === 'capabilities'
          ? { provider: 'github', connected: true }
          : [];
  };
  const spy: ForgeRepoSpy = {
    calls,
    capabilities: record('capabilities'),
    listPullRequests: record('listPullRequests'),
    getPullRequestDetail: record('getPullRequestDetail'),
    listPullRequestFiles: record('listPullRequestFiles'),
    listReviewThreads: record('listReviewThreads'),
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
  };
  return spy;
}

describe('ForgeRepoController', () => {
  const path = '/repos/demo';

  it('delegates capabilities and pull/issue/workflow routes to ForgeRepoService', async () => {
    const forge = makeSpy();
    const controller = new ForgeRepoController(forge as never);

    expect(controller.capabilities(path)).toEqual({ provider: 'github', connected: true });
    expect(forge.calls.capabilities).toEqual([[path]]);

    expect(controller.listPulls(path, 'closed')).toEqual([]);
    expect(forge.calls.listPullRequests).toEqual([[path, 'closed']]);

    expect(controller.getPull(path, '12')).toEqual([]);
    expect(forge.calls.getPullRequestDetail).toEqual([[path, 12]]);

    expect(controller.listPullFiles(path, '3')).toEqual([]);
    expect(forge.calls.listPullRequestFiles).toEqual([[path, 3]]);

    expect(controller.listThreads(path, '4')).toEqual([]);
    expect(forge.calls.listReviewThreads).toEqual([[path, 4]]);

    await expect(controller.replyToThread(path, '5', 'thread-1', { body: ' hi ' })).resolves.toEqual({
      ok: true,
    });
    expect(forge.calls.replyToThread).toEqual([[path, 5, 'thread-1', ' hi ']]);

    await expect(controller.resolveThread(path, '6', 'thread-2', { resolved: false })).resolves.toEqual({
      ok: true,
    });
    expect(forge.calls.resolveThread).toEqual([[path, 6, 'thread-2', false]]);

    await expect(
      controller.submitReview(path, '7', { event: 'approve', body: 'lgtm' }),
    ).resolves.toEqual({ ok: true });
    expect(forge.calls.submitReview).toEqual([[path, 7, { event: 'approve', body: 'lgtm' }]]);

    await expect(controller.addPullComment(path, '8', { body: 'note' })).resolves.toEqual({ ok: true });
    expect(forge.calls.addPullRequestComment).toEqual([[path, 8, 'note']]);

    expect(
      controller.mergePull(path, '9', {
        method: 'squash',
        deleteSourceBranch: true,
        mergeWhenChecksPass: true,
        commitTitle: 'title',
        commitMessage: 'msg',
      }),
    ).toEqual({ number: 1, url: 'https://example/pr/1' });
    expect(forge.calls.mergePullRequest).toEqual([
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
    expect(forge.calls.updatePullRequestState).toEqual([[path, 10, 'closed']]);

    await expect(controller.updateBranch(path, '11')).resolves.toEqual({ ok: true });
    expect(forge.calls.updateBranch).toEqual([[path, 11]]);

    expect(controller.listRuns(path, ' main ')).toEqual([]);
    expect(forge.calls.listWorkflowRuns).toEqual([[path, 'main']]);

    expect(controller.listRunJobs(path, '22')).toEqual([]);
    expect(forge.calls.getWorkflowRunJobs).toEqual([[path, 22]]);

    await expect(controller.rerunRun(path, '23', { failedOnly: true })).resolves.toEqual({ ok: true });
    expect(forge.calls.rerunWorkflowRun).toEqual([[path, 23, true]]);

    await expect(controller.cancelRun(path, '24')).resolves.toEqual({ ok: true });
    expect(forge.calls.cancelWorkflowRun).toEqual([[path, 24]]);

    expect(controller.getJobLog(path, '25')).toEqual({ text: 'log' });
    expect(forge.calls.getJobLog).toEqual([[path, 25]]);

    expect(controller.listIssues(path)).toEqual([]);
    expect(forge.calls.listIssues).toEqual([[path, 'open']]);

    expect(controller.getIssue(path, '30')).toEqual([]);
    expect(forge.calls.getIssue).toEqual([[path, 30]]);

    await expect(controller.addIssueComment(path, '31', { body: 'fix' })).resolves.toEqual({ ok: true });
    expect(forge.calls.addIssueComment).toEqual([[path, 31, 'fix']]);

    await expect(controller.updateIssueState(path, '32', { state: 'open' })).resolves.toEqual({ ok: true });
    expect(forge.calls.updateIssueState).toEqual([[path, 32, 'open']]);

    expect(controller.createIssue(path, { title: 'Bug', body: 'details', labels: ['bug'] })).toEqual({
      number: 1,
      url: 'https://example/pr/1',
    });
    expect(forge.calls.createIssue).toEqual([[path, { title: 'Bug', body: 'details', labels: ['bug'] }]]);
  });

  it('rejects invalid numeric path params', () => {
    const controller = new ForgeRepoController(makeSpy() as never);
    expect(() => controller.getPull(path, '0')).toThrow(BadRequestException);
    expect(() => controller.getPull(path, 'abc')).toThrow(BadRequestException);
  });

  it('rejects invalid state filters and open/closed transitions', async () => {
    const controller = new ForgeRepoController(makeSpy() as never);
    expect(() => controller.listPulls(path, 'merged')).toThrow(BadRequestException);
    await expect(controller.updatePullState(path, '1', { state: 'merged' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.updateIssueState(path, '1', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid review events and merge methods', async () => {
    const controller = new ForgeRepoController(makeSpy() as never);
    await expect(controller.submitReview(path, '1', { event: 'ship' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(() =>
      controller.mergePull(path, '1', { method: 'fast-forward' as never }),
    ).toThrow(BadRequestException);
  });
});
