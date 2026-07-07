import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { SettingsService } from '../../../src/settings/settings.service';
import { ProjectsModule } from '../../../src/projects/projects.module';
import { ProjectDefaultsResolver } from '../../../src/projects/project-defaults-resolver';
import { ProjectsRepository } from '../../../src/projects/projects.repository';

/**
 * Per-project defaults layer ABOVE the global chain, preserving today's behavior
 * when no project row exists:
 *   project override → global setting (DB → env → default) → registry default.
 * RED until the resolver exists. Pure over (project row | null, settings) — no
 * running provider, no engine branch (ADR-004).
 */
describe('ProjectDefaultsResolver — layered resolution order', () => {
  let module: TestingModule;
  let resolver: ProjectDefaultsResolver;
  let projects: ProjectsRepository;
  let settings: SettingsService;
  let dataDir: string;
  let workspace: string;
  const prior: Record<string, string | undefined> = {};

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-proj-resolver-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule, SettingsModule, ProjectsModule],
    }).compile();
    resolver = module.get(ProjectDefaultsResolver);
    projects = module.get(ProjectsRepository);
    settings = module.get(SettingsService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  let seq = 0;
  beforeEach(() => {
    seq += 1;
    workspace = mkdtempSync(join(tmpdir(), `nuncio-proj-ws-${seq}-`));
    prior.NUNCIO_VERIFY_COMMAND = process.env.NUNCIO_VERIFY_COMMAND;
    delete process.env.NUNCIO_VERIFY_COMMAND;
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    try {
      projects.delete(workspace);
      settings.clear('NUNCIO_VERIFY_COMMAND');
    } catch {
      // not implemented yet in the red phase
    }
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('verify command resolution order', () => {
    it('project override wins over a .nuncio/verify script and the global setting', () => {
      mkdirSync(join(workspace, '.nuncio'), { recursive: true });
      writeFileSync(join(workspace, '.nuncio', 'verify'), 'echo project-file\n');
      settings.set('NUNCIO_VERIFY_COMMAND', 'global-cmd');
      projects.upsert({ path: workspace, verifyCommand: 'project-override' });

      expect(resolver.resolveVerifyCommand(workspace)).toBe('project-override');
    });

    it('falls through to the global setting when the project has no override', () => {
      settings.set('NUNCIO_VERIFY_COMMAND', 'global-cmd');
      projects.upsert({ path: workspace }); // row exists but no verify override
      expect(resolver.resolveVerifyCommand(workspace)).toBe('global-cmd');
    });

    it('falls through to the env var when neither project nor DB setting is set', () => {
      process.env.NUNCIO_VERIFY_COMMAND = 'env-cmd';
      expect(resolver.resolveVerifyCommand(workspace)).toBe('env-cmd');
    });

    it('returns null when nothing configures a verify command', () => {
      expect(resolver.resolveVerifyCommand(workspace)).toBeNull();
    });
  });

  describe('unknown-project soft reference', () => {
    it('a path with no projects row resolves exactly to the global chain (backwards-compatible)', () => {
      settings.set('NUNCIO_VERIFY_COMMAND', 'global-cmd');
      // No project row for this path — must behave as today.
      expect(resolver.resolveVerifyCommand('/never/configured/repo')).toBe('global-cmd');
    });

    it('a null project path resolves to the global chain', () => {
      settings.set('NUNCIO_VERIFY_COMMAND', 'global-cmd');
      expect(resolver.resolveVerifyCommand(null)).toBe('global-cmd');
    });
  });

  describe('worktree policy resolution', () => {
    it('project policy wins; otherwise defaults to optional (today\'s implicit default)', () => {
      projects.upsert({ path: workspace, worktreePolicy: 'always' });
      expect(resolver.resolveWorktreePolicy(workspace)).toBe('always');
      const other = mkdtempSync(join(tmpdir(), 'nuncio-proj-ws-none-'));
      expect(resolver.resolveWorktreePolicy(other)).toBe('optional');
      rmSync(other, { recursive: true, force: true });
    });
  });

  describe('default engine resolution (no engine branch)', () => {
    it('project default engine wins when set', () => {
      projects.upsert({ path: workspace, defaultEngine: 'cursor' });
      expect(resolver.resolveDefaultEngine(workspace)).toBe('cursor');
    });

    it('inherits (null) when the project has no engine override', () => {
      projects.upsert({ path: workspace });
      expect(resolver.resolveDefaultEngine(workspace)).toBeNull();
    });
  });
});
