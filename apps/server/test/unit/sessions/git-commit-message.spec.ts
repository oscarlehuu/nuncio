import { BadRequestException } from '@nestjs/common';
import { GitCommitMessageService } from '../../../src/sessions/git-commit-message.service';
import type { GitService } from '../../../src/git/git.service';
import type { AgentRegistry } from '../../../src/agents/agents.registry';
import type { AgentProvider } from '../../../src/agents/agents.types';
import type { SettingsService } from '../../../src/settings/settings.service';

interface OneShotInput {
  prompt: string;
  systemPrompt?: string;
  model?: string | null;
}

function makeService(overrides: {
  diff?: string;
  files?: Array<{ path: string; index: string; workTree: string }>;
  /** Sequential completions; a single value repeats. Error rejects that call. */
  completions?: Array<string | Error>;
  provider?: Partial<AgentProvider> | null;
  historySubjects?: string[];
  settings?: Record<string, string | undefined>;
}) {
  const completions = overrides.completions ?? ['feat: add greeting helper'];
  let call = 0;
  const completeOneShot = jest.fn(async () => {
    const next = completions[Math.min(call, completions.length - 1)]!;
    call += 1;
    if (next instanceof Error) throw next;
    return next;
  });
  const provider =
    overrides.provider === null
      ? undefined
      : ({ id: 'pi', name: 'Pi', completeOneShot, ...overrides.provider } as unknown as AgentProvider);
  const files = overrides.files ?? [{ path: 'app.js', index: ' ', workTree: 'M' }];
  const git = {
    status: jest.fn(async () => ({
      branch: 'nuncio/s1',
      ahead: 0,
      behind: 0,
      clean: files.length === 0,
      files,
    })),
    diff: jest.fn(async () => ({ diff: overrides.diff ?? '+function greet() {}', truncated: false })),
    history: jest.fn(async () => ({
      branch: 'main',
      commits: (overrides.historySubjects ?? []).map((subject, i) => ({
        sha: `sha${i}`,
        shortSha: `s${i}`,
        subject,
        authorName: 'dev',
        authoredAt: '2026-07-21T00:00:00Z',
        parents: [],
      })),
    })),
  } as unknown as GitService;
  const agents = {
    available: jest.fn(async () => (provider ? [provider] : [])),
  } as unknown as AgentRegistry;
  const stored: Record<string, string | undefined> = { ...(overrides.settings ?? {}) };
  const settings = {
    resolve: jest.fn((key: string) => stored[key]),
    set: jest.fn((key: string, value: string) => {
      stored[key] = value;
    }),
  } as unknown as SettingsService;
  const service = new GitCommitMessageService(git, agents, settings);
  const inputAt = (index: number): OneShotInput =>
    (completeOneShot.mock.calls[index] as unknown as [OneShotInput])[0];
  return { service, git, agents, completeOneShot, settings, stored, inputAt };
}

const MANY_SUBJECTS = [
  'feat(web): add commit box',
  'fix(server): guard handoff status',
  'docs: refresh surfaces map',
  'chore: bump deps',
  'refactor(web): fold git actions into dock',
  'feat(mobile): hand off sheet',
];

describe('GitCommitMessageService', () => {
  it('generates a message from the working-tree diff via a one-shot completion', async () => {
    const { service, git, inputAt } = makeService({ completions: ['feat: add greeting helper'] });

    const result = await service.generate('/repo/worktree');

    expect(result.message).toBe('feat: add greeting helper');
    // Staged changes must be described too: the prompt diff is vs HEAD.
    expect((git as unknown as { diff: jest.Mock }).diff).toHaveBeenCalledWith('/repo/worktree', {
      base: 'HEAD',
    });
    const input = inputAt(0);
    expect(input.prompt).toContain('+function greet() {}');
    expect(input.prompt).toContain('app.js');
    expect(input.systemPrompt).toMatch(/commit message/i);
  });

  it('strips code fences and surrounding quotes from the completion', async () => {
    const { service } = makeService({
      completions: ['```\nfix: correct token refresh race\n```'],
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
    const { service } = makeService({ completions: ['   '] });

    await expect(service.generate('/repo/worktree')).rejects.toThrow(BadRequestException);
  });

  it('passes the configured model through to the completion', async () => {
    const { service, inputAt } = makeService({
      settings: { NUNCIO_COMMIT_MESSAGE_MODEL: 'cliproxyapi:claude-haiku-4-5' },
    });

    await service.generate('/repo/worktree');
    expect(inputAt(0).model).toBe('cliproxyapi:claude-haiku-4-5');
  });

  it('uses the user instruction verbatim and skips learning', async () => {
    const { service, git, completeOneShot, inputAt } = makeService({
      settings: { NUNCIO_COMMIT_MESSAGE_INSTRUCTION: 'Always write in Vietnamese imperative.' },
      historySubjects: MANY_SUBJECTS,
    });

    await service.generate('/repo/worktree');

    expect(completeOneShot).toHaveBeenCalledTimes(1);
    expect(inputAt(0).systemPrompt).toContain('Always write in Vietnamese imperative.');
    expect((git as unknown as { history: jest.Mock }).history).not.toHaveBeenCalled();
  });

  it('learns an instruction from commit history, persists it, and uses it', async () => {
    const { service, completeOneShot, settings, inputAt } = makeService({
      historySubjects: MANY_SUBJECTS,
      completions: [
        'Use conventional commits with a scoped prefix and imperative mood.',
        'feat(scm): add farewell helper',
      ],
    });

    const result = await service.generate('/repo/worktree');

    expect(result.message).toBe('feat(scm): add farewell helper');
    expect(completeOneShot).toHaveBeenCalledTimes(2);
    // First call learns from the repo's subjects…
    expect(inputAt(0).prompt).toContain('feat(web): add commit box');
    expect(inputAt(0).systemPrompt).toMatch(/style/i);
    // …the learned instruction is persisted for the Settings UI…
    expect(settings.set).toHaveBeenCalledWith(
      'NUNCIO_COMMIT_MESSAGE_INSTRUCTION',
      'Use conventional commits with a scoped prefix and imperative mood.',
    );
    // …and drives the actual generation.
    expect(inputAt(1).systemPrompt).toContain(
      'Use conventional commits with a scoped prefix and imperative mood.',
    );
  });

  it('skips learning on a repo with too little history', async () => {
    const { service, completeOneShot, settings, inputAt } = makeService({
      historySubjects: ['init'],
    });

    await service.generate('/repo/worktree');

    expect(completeOneShot).toHaveBeenCalledTimes(1);
    expect(settings.set).not.toHaveBeenCalled();
    // Falls back to the built-in conventional-commit style.
    expect(inputAt(0).systemPrompt).toMatch(/conventional-commit/i);
  });

  it('falls back to the default style when learning fails, without persisting', async () => {
    const { service, completeOneShot, settings } = makeService({
      historySubjects: MANY_SUBJECTS,
      completions: [new Error('engine hiccup'), 'fix: recover gracefully'],
    });

    const result = await service.generate('/repo/worktree');

    expect(result.message).toBe('fix: recover gracefully');
    expect(completeOneShot).toHaveBeenCalledTimes(2);
    expect(settings.set).not.toHaveBeenCalled();
  });
});
