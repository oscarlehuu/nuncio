import { BadRequestException } from '@nestjs/common';
import { GitCommitMessageService } from '../../../src/sessions/git-commit-message.service';
import type { GitService } from '../../../src/git/git.service';
import type { AgentRegistry } from '../../../src/agents/agents.registry';
import type { AgentProvider } from '../../../src/agents/agents.types';

function makeService(overrides: {
  diff?: string;
  files?: Array<{ path: string; index: string; workTree: string }>;
  completion?: string | Error;
  provider?: Partial<AgentProvider> | null;
}) {
  const completeOneShot = jest.fn(async () => {
    if (overrides.completion instanceof Error) throw overrides.completion;
    return overrides.completion ?? 'feat: add greeting helper';
  });
  const provider =
    overrides.provider === null
      ? undefined
      : ({ id: 'pi', name: 'Pi', completeOneShot, ...overrides.provider } as unknown as AgentProvider);
  const git = {
    status: jest.fn(async () => ({
      branch: 'nuncio/s1',
      ahead: 0,
      behind: 0,
      clean: (overrides.files ?? [{ path: 'app.js', index: ' ', workTree: 'M' }]).length === 0,
      files: overrides.files ?? [{ path: 'app.js', index: ' ', workTree: 'M' }],
    })),
    diff: jest.fn(async () => ({ diff: overrides.diff ?? '+function greet() {}', truncated: false })),
  } as unknown as GitService;
  const agents = {
    available: jest.fn(async () => (provider ? [provider] : [])),
  } as unknown as AgentRegistry;
  const service = new GitCommitMessageService(git, agents);
  return { service, git, agents, completeOneShot };
}

describe('GitCommitMessageService', () => {
  it('generates a message from the working-tree diff via a one-shot completion', async () => {
    const { service, completeOneShot } = makeService({ completion: 'feat: add greeting helper' });

    const result = await service.generate('/repo/worktree');

    expect(result.message).toBe('feat: add greeting helper');
    const input = (completeOneShot.mock.calls[0] as unknown as [
      { prompt: string; systemPrompt?: string },
    ])[0];
    expect(input.prompt).toContain('+function greet() {}');
    expect(input.prompt).toContain('app.js');
    expect(input.systemPrompt).toMatch(/commit message/i);
  });

  it('strips code fences and surrounding quotes from the completion', async () => {
    const { service } = makeService({
      completion: '```\nfix: correct token refresh race\n```',
    });

    const result = await service.generate('/repo/worktree');
    expect(result.message).toBe('fix: correct token refresh race');
  });

  it('rejects when the working tree is clean', async () => {
    const { service, completeOneShot } = makeService({ files: [] });

    await expect(service.generate('/repo/worktree')).rejects.toThrow(BadRequestException);
    expect(completeOneShot).not.toHaveBeenCalled();
  });

  it('rejects when no available engine supports one-shot completions', async () => {
    const { service } = makeService({ provider: null });

    await expect(service.generate('/repo/worktree')).rejects.toThrow(BadRequestException);
  });

  it('rejects an empty completion instead of returning a blank message', async () => {
    const { service } = makeService({ completion: '   ' });

    await expect(service.generate('/repo/worktree')).rejects.toThrow(BadRequestException);
  });
});
