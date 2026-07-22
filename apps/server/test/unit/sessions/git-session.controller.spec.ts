import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import { GitSessionController } from '../../../src/sessions/api/git-session.controller';
import type { SessionDto } from '../../../src/sessions/domain/sessions.types';
import type {
  CommitResultDto,
  GitBranchSyncDto,
  GitStatusDto,
  GitUnpushedCommitsDto,
} from '../../../src/git/git.types';

function makeSession(over: Partial<SessionDto> = {}): SessionDto {
  return {
    id: 's1',
    title: 't',
    status: 'IDLE',
    provider: 'pi',
    model: null,
    modelOptions: null,
    mode: null,
    workspace: '/repo',
    prompt: 'p',
    preview: null,
    projectPath: '/repo',
    baseBranch: 'main',
    worktreePath: '/wt/s1',
    branch: 'nuncio/s1-slug',
    providerThreadId: null,
    providerActiveTurnId: null,
    providerState: null,
    cursorBackend: null,
    cursorChatId: null,
    supportsInteraction: false,
    supportsInterrupt: false,
    supportsSteerWhileRunning: false,
    supportsImages: false,
    pendingInput: false,
    parentSessionId: null,
    originTaskId: null,
    priorSessionId: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

type GitSpy = {
  status: ReturnType<typeof createSpy>;
  branchSync: ReturnType<typeof createSpy>;
  unpushedCommits: ReturnType<typeof createSpy>;
  diff: ReturnType<typeof createSpy>;
  commitDiff: ReturnType<typeof createSpy>;
  stashList: ReturnType<typeof createSpy>;
  blame: ReturnType<typeof createSpy>;
  history: ReturnType<typeof createSpy>;
  pull: ReturnType<typeof createSpy>;
  stageAll: ReturnType<typeof createSpy>;
  commit: ReturnType<typeof createSpy>;
  push: ReturnType<typeof createSpy>;
};

function createSpy<T>(impl: (...args: unknown[]) => T) {
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls, mockReturnValue(value: T) { impl = () => value; } });
}

describe('GitSessionController', () => {
  const gitDir = '/wt/s1';
  const gitStatus: GitStatusDto = {
    branch: 'nuncio/s1-slug',
    ahead: 0,
    behind: 0,
    clean: true,
    files: [],
  };
  const branchSync: GitBranchSyncDto = {
    branch: 'nuncio/s1-slug',
    base: 'main',
    ahead: 0,
    behind: 0,
    outgoing: [],
    incoming: [],
    conflicts: [],
    clean: true,
  };
  const unpushed: GitUnpushedCommitsDto = {
    branch: 'nuncio/s1-slug',
    base: 'main',
    commits: [],
  };
  const commitResult: CommitResultDto = { sha: 'abc123', committed: true };

  function controllerFor(session: SessionDto | null) {
    const sessions = {
      get: (id: string) => {
        expect(id).toBe('s1');
        return session;
      },
    };
    const git: GitSpy = {
      status: createSpy(() => Promise.resolve(gitStatus)),
      branchSync: createSpy(() => Promise.resolve(branchSync)),
      unpushedCommits: createSpy(() => Promise.resolve(unpushed)),
      diff: createSpy(() => ({ diff: '', truncated: false })),
      commitDiff: createSpy(() => ({ diff: '', truncated: false })),
      stashList: createSpy(() => []),
      blame: createSpy(() => ({ lines: [] })),
      history: createSpy(() => []),
      pull: createSpy(() => ({ ok: true })),
      stageAll: createSpy(async () => undefined),
      commit: createSpy(() => commitResult),
      push: createSpy(() => ({ ok: true })),
    };
    const commitMessages = { generate: createSpy(async () => ({ message: 'feat: x' })) };
    return {
      controller: new GitSessionController(sessions as never, git as never, commitMessages as never),
      git,
      commitMessages,
    };
  }

  it('status resolves the session git dir and delegates to GitService', async () => {
    const { controller, git } = controllerFor(makeSession());
    await expect(controller.status('s1')).resolves.toEqual(gitStatus);
    expect(git.status.calls).toEqual([[gitDir]]);
  });

  it('sync returns branch sync metadata for the session cwd', async () => {
    const { controller, git } = controllerFor(makeSession());
    await expect(controller.sync('s1')).resolves.toEqual(branchSync);
    expect(git.branchSync.calls).toEqual([[gitDir, { fallbackBase: 'main' }]]);
  });

  it('unpushed lists unpushed commits for the session cwd', async () => {
    const { controller, git } = controllerFor(makeSession());
    await expect(controller.unpushed('s1')).resolves.toEqual(unpushed);
    expect(git.unpushedCommits.calls).toEqual([[gitDir, { fallbackBase: 'main' }]]);
  });

  it('diff forwards staged/base/path query flags', () => {
    const { controller, git } = controllerFor(makeSession());
    controller.diff('s1', 'true', 'main', 'src/a.ts');
    expect(git.diff.calls).toEqual([
      [gitDir, { staged: true, base: 'main', path: 'src/a.ts' }],
    ]);
  });

  it('commitDiff delegates to GitService with the sha', () => {
    const { controller, git } = controllerFor(makeSession());
    controller.commitDiff('s1', 'deadbeef');
    expect(git.commitDiff.calls).toEqual([[gitDir, 'deadbeef']]);
  });

  it('blame requires a path query param', () => {
    const { controller } = controllerFor(makeSession());
    expect(() => controller.blame('s1', '  ')).toThrow(BadRequestException);
  });

  it('history parses a numeric limit when provided', () => {
    const { controller, git } = controllerFor(makeSession());
    controller.history('s1', '25');
    expect(git.history.calls).toEqual([[gitDir, { limit: 25 }]]);
  });

  it('history forwards an optional branch query param', () => {
    const { controller, git } = controllerFor(makeSession());
    controller.history('s1', '15', 'feat/other');
    expect(git.history.calls).toEqual([[gitDir, { limit: 15, branch: 'feat/other' }]]);
  });

  it('commit stages all by default and requires a message', async () => {
    const { controller, git } = controllerFor(makeSession());
    await expect(controller.commit('s1', { message: '  ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.commit('s1', { message: 'fix bug' })).resolves.toEqual(commitResult);
    expect(git.stageAll.calls).toEqual([[gitDir]]);
    expect(git.commit.calls).toEqual([[gitDir, 'fix bug']]);
  });

  it('commit skips stageAll when stageAll is false', async () => {
    const { controller, git } = controllerFor(makeSession());
    await controller.commit('s1', { message: 'wip', stageAll: false });
    expect(git.stageAll.calls).toEqual([]);
    expect(git.commit.calls).toEqual([[gitDir, 'wip']]);
  });

  it('uses plain push semantics for an ordinary session even when its stored branch differs', async () => {
    const { controller, git } = controllerFor(makeSession({ branch: null }));
    await controller.push('s1', { force: true });
    expect(git.status.calls).toEqual([[gitDir]]);
    expect(git.push.calls).toEqual([[
      gitDir,
      'nuncio/s1-slug',
      { force: true },
    ]]);
  });

  it('pushes an adopted PR worktree branch back to the PR source branch', async () => {
    const { controller, git } = controllerFor(makeSession({
      branch: 'feat/pr-head',
      forgeProvider: 'github',
      pullRequestNumber: 7,
      baseBranch: 'refs/nuncio/pull-requests/github/7',
    }));
    await controller.push('s1', {});
    expect(git.push.calls).toEqual([[
      gitDir,
      'nuncio/s1-slug',
      { force: false, remoteBranch: 'feat/pr-head' },
    ]]);
  });

  it('does not use PR metadata alone as a remote push target', async () => {
    const { controller, git } = controllerFor(makeSession({
      branch: 'main',
      forgeProvider: 'github',
      pullRequestNumber: 7,
      baseBranch: 'main',
    }));
    git.status.mockReturnValue(Promise.resolve({ ...gitStatus, branch: 'feature/current' }));

    await controller.push('s1', {});

    expect(git.push.calls).toEqual([[
      gitDir,
      'feature/current',
      { force: false },
    ]]);
  });

  it('push rejects sessions without a pushable branch', async () => {
    const { controller, git } = controllerFor(makeSession({ branch: null }));
    git.status.mockReturnValue(Promise.resolve({ ...gitStatus, branch: 'HEAD' }));
    await expect(controller.push('s1', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requireSessionGitDir throws when the session is missing', () => {
    const { controller } = controllerFor(null);
    expect(() => controller.status('s1')).toThrow(NotFoundException);
  });

  it('requireSessionGitDir throws when the session has no git working directory', () => {
    const { controller } = controllerFor(
      makeSession({ worktreePath: null, workspace: null, projectPath: null }),
    );
    expect(() => controller.status('s1')).toThrow(BadRequestException);
  });
});
