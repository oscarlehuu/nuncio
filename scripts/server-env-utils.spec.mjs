import { describe, expect, test } from 'bun:test';
import {
  findMainWorktreeEnv,
  parseGitWorktrees,
  resolveEnvPath,
  resolveServerEnvFile,
} from './server-env-utils.mjs';

describe('server env resolver', () => {
  test('parses git worktree porcelain output', () => {
    const output = [
      'worktree /repo/main',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo/feature',
      'HEAD def456',
      'detached',
      '',
    ].join('\n');

    expect(parseGitWorktrees(output)).toEqual([
      { path: '/repo/main', branch: 'refs/heads/main' },
      { path: '/repo/feature' },
    ]);
  });

  test('resolves explicit env paths relative to the repo root', () => {
    expect(resolveEnvPath('.env.local', '/repo/worktree', '/Users/test')).toBe('/repo/worktree/.env.local');
    expect(resolveEnvPath('~/.nuncio/.env', '/repo/worktree', '/Users/test')).toBe('/Users/test/.nuncio/.env');
  });

  test('selects the main worktree env before the current worktree env', () => {
    const worktreeOutput = [
      'worktree /repo/main',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo/worktree',
      'HEAD def456',
      'branch refs/heads/codex/provider',
      '',
    ].join('\n');
    const existing = new Set(['/repo/main/.env', '/repo/worktree/.env']);

    expect(findMainWorktreeEnv('/repo/worktree', worktreeOutput, (path) => existing.has(path))).toBe('/repo/main/.env');
  });

  test('uses the primary checkout env when the primary checkout is not on main', () => {
    const worktreeOutput = [
      'worktree /repo/main-checkout',
      'HEAD abc123',
      'branch refs/heads/dev',
      '',
      'worktree /repo/worktree',
      'HEAD def456',
      'detached',
      '',
    ].join('\n');
    const existing = new Set(['/repo/main-checkout/.env', '/repo/worktree/.env']);

    expect(findMainWorktreeEnv('/repo/worktree', worktreeOutput, (path) => existing.has(path))).toBe(
      '/repo/main-checkout/.env',
    );
  });

  test('falls back to the current checkout env when no main worktree env exists', () => {
    const worktreeOutput = [
      'worktree /repo/worktree',
      'HEAD def456',
      'branch refs/heads/codex/provider',
      '',
    ].join('\n');
    const existing = new Set(['/repo/worktree/.env']);

    expect(findMainWorktreeEnv('/repo/worktree', worktreeOutput, (path) => existing.has(path))).toBe(
      '/repo/worktree/.env',
    );
  });

  test('lets NUNCIO_ENV_FILE override worktree discovery', () => {
    const existing = new Set(['/repo/worktree/custom.env', '/repo/main/.env']);

    expect(
      resolveServerEnvFile({
        repoRoot: '/repo/worktree',
        env: { NUNCIO_ENV_FILE: 'custom.env' },
        homeDir: '/Users/test',
        exists: (path) => existing.has(path),
        runGit: () => 'worktree /repo/main\nbranch refs/heads/main\n',
      }),
    ).toBe('/repo/worktree/custom.env');
  });

  test('fails fast when NUNCIO_ENV_FILE points to a missing file', () => {
    expect(() =>
      resolveServerEnvFile({
        repoRoot: '/repo/worktree',
        env: { NUNCIO_ENV_FILE: 'missing.env' },
        homeDir: '/Users/test',
        exists: () => false,
        runGit: () => 'worktree /repo/main\nbranch refs/heads/main\n',
      }),
    ).toThrow('NUNCIO_ENV_FILE points to a missing file: /repo/worktree/missing.env');
  });

  test('uses the shared Nuncio env when no checkout env is available', () => {
    const existing = new Set(['/Users/test/.nuncio/.env']);

    expect(
      resolveServerEnvFile({
        repoRoot: '/repo/worktree',
        env: {},
        homeDir: '/Users/test',
        exists: (path) => existing.has(path),
        runGit: () => '',
      }),
    ).toBe('/Users/test/.nuncio/.env');
  });
});
