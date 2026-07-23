import { describe, expect, it } from 'bun:test';
import { routePullRequestLifecycle } from '../../../src/forges/webhooks/webhook-pr-lifecycle-router';

function makeEvent(over: Record<string, unknown> = {}) {
  return {
    provider: 'github',
    deliveryId: 'd1',
    kind: 'pull_request',
    action: 'closed',
    owner: 'octo',
    repo: 'nuncio',
    repoFullName: 'octo/nuncio',
    defaultBranch: 'main',
    number: 7,
    merged: false,
    url: 'https://github.com/octo/nuncio/pull/7',
    labels: [],
    ...over,
  } as never;
}

function makeDeps(over: Record<string, unknown> = {}) {
  const cleared: Array<[string, string]> = [];
  const raised: Array<Record<string, unknown>> = [];
  const forgeStateUpdates: Array<Record<string, unknown>> = [];
  const deps = {
    sessions: {
      archive: () => ({ status: 'ARCHIVED' }),
    },
    sessionRecords: {
      findByProjectPullRequest: () => ({
        id: 'sess-1',
        status: 'IDLE',
        projectPath: '/repos/nuncio',
        worktreePath: '/worktrees/sess-1',
        baseBranch: 'main',
      }),
      updateForgeState: (_id: string, state: Record<string, unknown>) => {
        forgeStateUpdates.push(state);
      },
      findActiveSuccessor: () => null,
      clearWorktreeMetadata: () => undefined,
    },
    git: {
      status: async () => ({ clean: true }),
      unpushedCommits: async () => ({ commits: [] }),
      removeWorktreeIfSafe: async () => ({ removed: true }),
    },
    forgeRepos: {
      resolveRepoIdentity: async () => 'github.com/octo/nuncio',
    },
    attention: {
      raise: (signal: Record<string, unknown>) => {
        raised.push(signal);
      },
      onConditionCleared: (kind: string, subjectId: string) => {
        cleared.push([kind, subjectId]);
      },
    },
    accept: (work: () => unknown) => work(),
    deliveryRetrying: false,
    cleanupCheckpoint: null,
    markCleanupCheckpoint: () => undefined,
    ...over,
  };
  return { deps, cleared, raised, forgeStateUpdates };
}

describe('routePullRequestLifecycle', () => {
  it('clears both the forge-resolved canonical key and the legacy project-path key', async () => {
    const { deps, cleared } = makeDeps();

    await routePullRequestLifecycle(deps as never, 'github', '/repos/nuncio', makeEvent(), true);

    expect(cleared).toContainEqual(['pr-review', 'github.com/octo/nuncio#7']);
    expect(cleared).toContainEqual(['pr-review', '/repos/nuncio#7']);
    expect(cleared).toContainEqual(['pr-feedback', 'octo/nuncio#7']);
    expect(cleared).toContainEqual(['pr-feedback', 'octo/nuncio#7:delivery']);
    expect(cleared).toContainEqual(['pr-feedback', 'octo/nuncio#7:cleanup']);
  });

  it('falls back to the PR URL host when resolveRepoIdentity fails', async () => {
    const { deps, cleared } = makeDeps({
      forgeRepos: {
        resolveRepoIdentity: async () => {
          throw new Error('forge offline');
        },
      },
    });

    await routePullRequestLifecycle(
      deps as never,
      'github',
      '/repos/nuncio',
      makeEvent({ url: 'https://github.com/Octo/Nuncio/pull/7' }),
      true,
    );

    expect(cleared).toContainEqual(['pr-review', 'github.com/octo/nuncio#7']);
    expect(cleared).toContainEqual(['pr-review', '/repos/nuncio#7']);
  });

  it('falls back to the public provider host when the PR URL is unusable', async () => {
    const { deps, cleared } = makeDeps({
      forgeRepos: {
        resolveRepoIdentity: async () => {
          throw new Error('forge offline');
        },
      },
    });

    await routePullRequestLifecycle(
      deps as never,
      'gitlab',
      '/repos/nuncio',
      makeEvent({
        provider: 'gitlab',
        repoFullName: 'octo/nuncio',
        url: 'not-a-url',
      }),
      true,
    );

    expect(cleared).toContainEqual(['pr-review', 'gitlab.com/octo/nuncio#7']);
  });

  it('raises pr-feedback when no owning session exists', async () => {
    const { deps, raised } = makeDeps({
      sessionRecords: {
        findByProjectPullRequest: () => null,
        updateForgeState: () => undefined,
        findActiveSuccessor: () => null,
        clearWorktreeMetadata: () => undefined,
      },
    });

    const result = await routePullRequestLifecycle(
      deps as never,
      'github',
      '/repos/nuncio',
      makeEvent({ merged: true }),
      true,
    );

    expect(result).toEqual({ created: false, reason: 'no-owning-session' });
    expect(raised).toContainEqual(expect.objectContaining({
      kind: 'pr-feedback',
      subjectId: 'octo/nuncio#7',
      title: 'PR #7 closed without an owning session',
      payload: expect.objectContaining({ merged: true, number: 7 }),
    }));
  });
});
