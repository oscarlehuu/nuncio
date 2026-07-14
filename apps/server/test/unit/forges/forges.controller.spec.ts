import { describe, expect, it } from 'bun:test';
import { ForgesController } from '../../../src/forges/api/forges.controller';
import type { ForgePullRequest } from '../../../src/forges/forges.types';

describe('ForgesController', () => {
  const sessionId = 'session-1';
  const pullRequest: ForgePullRequest = {
    number: 42,
    url: 'https://github.com/o/r/pull/42',
    state: 'open',
    title: 'Fix',
  };

  it('opens and reads a session-scoped pull request', async () => {
    const calls: Record<string, unknown[][]> = {};
    const forges = {
      openPullRequestForSession: (...args: unknown[]) => {
        (calls.open ??= []).push(args);
        return Promise.resolve(pullRequest);
      },
      getPullRequestForSession: (...args: unknown[]) => {
        (calls.get ??= []).push(args);
        return Promise.resolve({ ...pullRequest, body: '', author: 'octo', draft: false, sourceBranch: 'feature', targetBranch: 'main', mergeable: 'mergeable' as const, reviewDecision: null, additions: 0, deletions: 0, changedFiles: 0, checks: [] });
      },
      addCommentForSession: async (...args: unknown[]) => {
        (calls.comment ??= []).push(args);
      },
    };
    const controller = new ForgesController(forges as never);

    await expect(
      controller.openPullRequest(sessionId, { title: 'Fix', body: 'details', draft: true }),
    ).resolves.toEqual(pullRequest);
    expect(calls.open).toEqual([[sessionId, { title: 'Fix', body: 'details', draft: true }]]);

    await expect(controller.getPullRequest(sessionId)).resolves.toMatchObject({ number: 42 });
    expect(calls.get).toEqual([[sessionId]]);
  });

  it('adds a pull-request comment and returns ok', async () => {
    const calls: unknown[][] = [];
    const controller = new ForgesController({
      openPullRequestForSession: async () => pullRequest,
      getPullRequestForSession: async () => ({ ...pullRequest, body: '', author: 'octo', draft: false, sourceBranch: 'feature', targetBranch: 'main', mergeable: 'mergeable' as const, reviewDecision: null, additions: 0, deletions: 0, changedFiles: 0, checks: [] }),
      addCommentForSession: async (...args: unknown[]) => {
        calls.push(args);
      },
    } as never);

    await expect(controller.addComment(sessionId, { body: 'ship it' })).resolves.toEqual({ ok: true });
    expect(calls).toEqual([[sessionId, 'ship it']]);
  });
});
