import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionDiffService } from '../../../../src/sessions/diff/session-diff.service';
import type { SessionDto } from '../../../../src/sessions/domain/sessions.types';

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
    branch: 'nuncio/s1',
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

describe('SessionDiffService', () => {
  function serviceFor(session: SessionDto | null) {
    const steerCalls: Array<[string, string]> = [];
    let diffImpl: () => Promise<{ diff: string; truncated: boolean }> = async () => ({
      diff: '',
      truncated: false,
    });
    const sessions = {
      get: () => session,
      steer: async (sessionId: string, message: string) => {
        steerCalls.push([sessionId, message]);
        return { id: session?.id, status: 'RUNNING' };
      },
    };
    const git = {
      resolveWorktreeDiffBase: async () => 'main',
      diff: async () => diffImpl(),
      setDiffImpl: (impl: typeof diffImpl) => {
        diffImpl = impl;
      },
    };
    const service = new SessionDiffService(git as never, sessions as never);
    service.onModuleInit();
    return { service, steerCalls, git };
  }

  it('binds resolveTarget from SessionsService on module init', () => {
    const { service } = serviceFor(makeSession());
    expect(service.resolveTarget('s1')).toEqual({
      gitDir: '/wt/s1',
      base: 'main',
      mode: 'worktree',
    });
  });

  it('uses local mode when the session has no worktree', () => {
    const { service } = serviceFor(makeSession({ worktreePath: null }));
    expect(service.resolveTarget('s1')).toEqual({
      gitDir: '/repo',
      base: null,
      mode: 'local',
    });
  });

  it('throws when the session is missing or has no git dir', () => {
    const { service } = serviceFor(null);
    expect(() => service.resolveTarget('s1')).toThrow(NotFoundException);

    const noDir = serviceFor(makeSession({ worktreePath: null, workspace: null, projectPath: null }));
    expect(() => noDir.service.resolveTarget('s1')).toThrow(BadRequestException);
  });

  it('returns an empty diff when git reports the directory is not a repository', async () => {
    const { service, git } = serviceFor(makeSession());
    git.setDiffImpl(async () => {
      throw new BadRequestException('Not a git repository: /wt/s1');
    });
    await expect(service.diff('s1')).resolves.toEqual({
      files: [],
      truncated: false,
      omittedFiles: 0,
    });
  });

  it('marks truncated diffs when git output was truncated', async () => {
    const { service, git } = serviceFor(makeSession());
    git.setDiffImpl(async () => ({
      diff: 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n',
      truncated: true,
    }));
    const result = await service.diff('s1');
    expect(result.truncated).toBe(true);
    expect(result.omittedFiles).toBeGreaterThanOrEqual(1);
  });

  it('comment validates the path and steers with a diff comment block', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'nuncio-session-diff-'));
    try {
      const { service, steerCalls } = serviceFor(
        makeSession({ worktreePath: repoDir, workspace: repoDir, projectPath: repoDir }),
      );
      await service.comment('s1', {
        path: 'src/a.ts',
        startLine: 1,
        endLine: 2,
        hunk: '-old\n+new',
        comment: 'please fix',
      });
      expect(steerCalls).toHaveLength(1);
      expect(steerCalls[0][0]).toBe('s1');
      expect(steerCalls[0][1]).toContain('Re: src/a.ts:1-2');
      expect(steerCalls[0][1]).toContain('please fix');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('rejects traversal paths in diff comments', async () => {
    const { service } = serviceFor(makeSession());
    await expect(
      service.comment('s1', {
        path: '../escape.ts',
        startLine: 1,
        endLine: 1,
        hunk: '',
        comment: 'nope',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
