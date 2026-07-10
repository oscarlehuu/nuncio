import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewVerifyCommandResolver } from '../../../src/crew/crew-verify-command.resolver';
import { CrewCommandRunner } from '../../../src/crew/crew-command.runner';

describe('CrewVerifyCommandResolver', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-verify-command-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('freezes project config before profile before global', () => {
    const projects = { findByPath: () => ({ verifyCommand: 'project-check' }) };
    const defaults = { resolveVerifyCommand: () => 'global-check' };
    const resolver = new CrewVerifyCommandResolver(projects as never, defaults as never);
    expect(resolver.resolve(root, 'profile-check')).toBe('project-check');
  });

  it('freezes an explicit run/project override before mutable project discovery', () => {
    const resolver = new CrewVerifyCommandResolver(
      { findByPath: () => ({ verifyCommand: 'stored-project-check' }) } as never,
      { resolveVerifyCommand: () => 'global-check' } as never,
    );
    expect(resolver.resolve(root, 'profile-check', 'run-check')).toBe('run-check');
  });

  it('freezes a project .nuncio/verify script through the shell before profile', () => {
    const projectPath = join(root, 'script-project');
    mkdirSync(join(projectPath, '.nuncio'), { recursive: true });
    writeFileSync(join(projectPath, '.nuncio', 'verify'), 'exit 0\n');
    const resolver = new CrewVerifyCommandResolver(
      { findByPath: () => null } as never,
      { resolveVerifyCommand: () => 'global-check' } as never,
    );
    expect(resolver.resolve(projectPath, 'profile-check')).toBe('sh ./.nuncio/verify');
  });

  it('runs a non-executable head-local worktree script rather than the mutable source checkout', async () => {
    const projectPath = join(root, 'source-project');
    const worktreePath = join(root, 'crew-worktree');
    mkdirSync(join(projectPath, '.nuncio'), { recursive: true });
    mkdirSync(join(worktreePath, '.nuncio'), { recursive: true });
    writeFileSync(join(projectPath, '.nuncio', 'verify'), '#!/bin/sh\nprintf source\n', { mode: 0o644 });
    writeFileSync(join(worktreePath, '.nuncio', 'verify'), '#!/bin/sh\nprintf worktree\n', { mode: 0o644 });
    const resolver = new CrewVerifyCommandResolver(
      { findByPath: () => null } as never, { resolveVerifyCommand: () => null } as never,
    );
    const command = resolver.resolve(projectPath, null)!;
    expect((await new CrewCommandRunner().run(command, worktreePath, 1000)).stdout).toBe('worktree');
  });

  it('uses frozen-head script presence instead of an untracked mutable checkout file', () => {
    const projectPath = join(root, 'untracked-script-project');
    mkdirSync(join(projectPath, '.nuncio'), { recursive: true });
    writeFileSync(join(projectPath, '.nuncio', 'verify'), 'exit 0\n');
    const resolver = new CrewVerifyCommandResolver(
      { findByPath: () => null } as never,
      { resolveVerifyCommand: () => null } as never,
    );
    const resolveAtHead = resolver.resolve.bind(resolver) as (
      projectPath: string | null, profile: string | null, explicit?: string | null,
      projectScriptAtHead?: boolean,
    ) => string | null;

    expect(resolveAtHead(projectPath, 'profile-check', null, false)).toBe('profile-check');
    expect(resolveAtHead(projectPath, null, null, true)).toBe('sh ./.nuncio/verify');
  });

  it('uses profile before the global fallback and returns null when all are absent', () => {
    const projects = { findByPath: () => null };
    const defaults = { resolveVerifyCommand: () => 'global-check' };
    const resolver = new CrewVerifyCommandResolver(projects as never, defaults as never);
    expect(resolver.resolve(root, ' profile-check ')).toBe('profile-check');
    expect(resolver.resolve(root, null)).toBe('global-check');
    const empty = new CrewVerifyCommandResolver(
      projects as never, { resolveVerifyCommand: () => null } as never,
    );
    expect(empty.resolve(root, null)).toBeNull();
  });

  it('rejects NUL and oversized commands from every mutable configuration source', () => {
    const invalidProject = new CrewVerifyCommandResolver(
      { findByPath: () => ({ verifyCommand: 'printf ok\0leak' }) } as never,
      { resolveVerifyCommand: () => null } as never,
    );
    expect(() => invalidProject.resolve(root, null)).toThrow('NUL');
    const invalidGlobal = new CrewVerifyCommandResolver(
      { findByPath: () => null } as never,
      { resolveVerifyCommand: () => 'x'.repeat(4097) } as never,
    );
    expect(() => invalidGlobal.resolve(root, null)).toThrow('4096');
  });
});
