import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { ProjectsModule } from '../../../src/projects/projects.module';
import { ProjectsRepository } from '../../../src/projects/projects.repository';
import { RecentProjectsRepository } from '../../../src/git/recent-projects.repository';

/**
 * Project config is durable SQLite (ADR-006) — a fresh module sees every row
 * unchanged. And the config entity COEXISTS with the recent_projects MRU picker:
 * they are distinct tables, neither writes the other. RED until the projects
 * table + repository exist.
 */
describe('Project entity — restart durability and recent_projects coexistence', () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-projects-restart-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  async function build(): Promise<TestingModule> {
    return Test.createTestingModule({
      imports: [DatabaseModule, GitModule, ProjectsModule],
    }).compile();
  }

  it('an empty database yields an empty project list (guarded migration from zero)', async () => {
    const module = await build();
    const repo = module.get(ProjectsRepository);
    expect(repo.list()).toEqual([]);
    await module.close();
  });

  it('rebuilds every project config row after a restart, unchanged', async () => {
    const first = await build();
    first.get(ProjectsRepository).upsert({
      path: '/repos/alpha',
      name: 'Alpha',
      defaultEngine: 'pi',
      worktreePolicy: 'always',
      verifyCommand: 'bun test',
    });
    first.get(ProjectsRepository).upsert({ path: '/repos/beta' });
    await first.close();

    const second = await build();
    const rows = second.get(ProjectsRepository).list();
    const alpha = rows.find((p) => p.path === '/repos/alpha');
    expect(alpha).toBeDefined();
    expect(alpha!.name).toBe('Alpha');
    expect(alpha!.defaultEngine).toBe('pi');
    expect(alpha!.worktreePolicy).toBe('always');
    expect(alpha!.verifyCommand).toBe('bun test');
    expect(rows.find((p) => p.path === '/repos/beta')).toBeDefined();
    await second.close();
  });

  it('recent_projects and projects are distinct — recording a recent does not create a config row', async () => {
    const module = await build();
    const recent = module.get(RecentProjectsRepository);
    const projects = module.get(ProjectsRepository);
    // Record a recent project (MRU picker) — must NOT create a config row.
    recent.record(dataDir); // dataDir exists on disk so recent.list keeps it
    expect(projects.findByPath(dataDir)).toBeNull();

    // Creating a config row must NOT add to the recent list.
    projects.upsert({ path: '/repos/config-only' });
    expect(recent.list().some((r) => r.path === '/repos/config-only')).toBe(false);
    await module.close();
  });
});
