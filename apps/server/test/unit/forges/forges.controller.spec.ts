import { describe, expect, it } from 'bun:test';
import { ForgesController } from '../../../src/forges/api/forges.controller';

describe('ForgesController', () => {
  const sessionId = 'session-1';

  it('opens and reads a session-scoped pull request', () => {
    const calls: Record<string, unknown[][]> = {};
    const forges = {
      openPullRequestForSession: (...args: unknown[]) => {
        (calls.open ??= []).push(args);
        return { number: 42, url: 'https://github.com/o/r/pull/42' };
      },
      getPullRequestForSession: (...args: unknown[]) => {
        (calls.get ??= []).push(args);
        return { number: 42 };
      },
      addCommentForSession: async (...args: unknown[]) => {
        (calls.comment ??= []).push(args);
      },
    };
    const controller = new ForgesController(forges as never);

    expect(controller.openPullRequest(sessionId, { title: 'Fix', body: 'details', draft: true })).toEqual({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
    });
    expect(calls.open).toEqual([[sessionId, { title: 'Fix', body: 'details', draft: true }]]);

    expect(controller.getPullRequest(sessionId)).toEqual({ number: 42 });
    expect(calls.get).toEqual([[sessionId]]);
  });

  it('adds a pull-request comment and returns ok', async () => {
    const calls: unknown[][] = [];
    const controller = new ForgesController({
      openPullRequestForSession: () => ({}),
      getPullRequestForSession: () => ({}),
      addCommentForSession: async (...args: unknown[]) => {
        calls.push(args);
      },
    } as never);

    await expect(controller.addComment(sessionId, { body: 'ship it' })).resolves.toEqual({ ok: true });
    expect(calls).toEqual([[sessionId, 'ship it']]);
  });
});
