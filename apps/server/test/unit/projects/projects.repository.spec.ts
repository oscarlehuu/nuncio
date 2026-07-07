import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { ProjectsModule } from '../../../src/projects/projects.module';
import { ProjectsRepository } from '../../../src/projects/projects.repository';

/**
 * Rung 2 sub-phase A — the project CONFIG entity (keyed by path). RED until the
 * repository + `projects` table exist. The config layer that loops and the fleet
 * view stand on; it extends (does not duplicate) recent_projects.
 */
describe('ProjectsRepository', () => {
  let module: TestingModule;
  let repo: ProjectsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-projects-repo-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule, ProjectsModule],
    }).compile();
    repo = module.get(ProjectsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  // Each test uses a distinct path so rows don't collide across cases.
  let seq = 0;
  let projectPath: string;
  beforeEach(() => {
    seq += 1;
    projectPath = `/tmp/nuncio-proj-${seq}/repo`;
  });
  afterEach(() => {
    try {
      repo.delete(projectPath);
    } catch {
      // repo not implemented yet in the red phase
    }
  });

  it('creates a project keyed by path, deriving the name from the basename', () => {
    const project = repo.upsert({ path: projectPath });
    expect(project.path).toBe(projectPath);
    expect(project.name).toBe('repo');
    expect(project.defaultEngine).toBeNull();
    expect(project.worktreePolicy).toBeNull();
    expect(project.verifyCommand).toBeNull();
    expect(typeof project.createdAt).toBe('number');
  });

  it('defaults the importance weight to 1 and patches it as a positive integer', () => {
    const created = repo.upsert({ path: projectPath });
    expect(created.weight).toBe(1); // equal importance by default (rung 3)

    const weighted = repo.upsert({ path: projectPath, weight: 7 });
    expect(weighted.weight).toBe(7);

    // Omitting weight on a later patch leaves it unchanged.
    const patched = repo.upsert({ path: projectPath, name: 'renamed' });
    expect(patched.weight).toBe(7);

    // Non-positive / non-integer weights are rejected at the boundary.
    expect(() => repo.upsert({ path: projectPath, weight: 0 })).toThrow(/weight/i);
    expect(() => repo.upsert({ path: projectPath, weight: -3 })).toThrow(/weight/i);
    expect(() => repo.upsert({ path: projectPath, weight: 1.5 })).toThrow(/weight/i);
  });

  it('dedups by path — a second upsert updates the same row, never a duplicate', () => {
    repo.upsert({ path: projectPath, name: 'first' });
    repo.upsert({ path: projectPath, name: 'second' });
    const all = repo.list().filter((p) => p.path === projectPath);
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('second');
  });

  it('normalizes a trailing slash so /repo and /repo/ are the same project', () => {
    repo.upsert({ path: projectPath });
    const withSlash = repo.upsert({ path: `${projectPath}/`, name: 'slashed' });
    expect(withSlash.path).toBe(projectPath);
    expect(repo.list().filter((p) => p.path === projectPath)).toHaveLength(1);
  });

  it('rejects an empty or whitespace-only path', () => {
    // Assert a PATH-specific validation error so a bare skeleton throw can't
    // false-pass this in the red phase.
    expect(() => repo.upsert({ path: '' })).toThrow(/path/i);
    expect(() => repo.upsert({ path: '   ' })).toThrow(/path/i);
  });

  it('accepts the valid worktree-policy values and rejects garbage', () => {
    for (const policy of ['always', 'never', 'optional'] as const) {
      const p = repo.upsert({ path: `${projectPath}-${policy}`, worktreePolicy: policy });
      expect(p.worktreePolicy).toBe(policy);
      repo.delete(`${projectPath}-${policy}`);
    }
    expect(() =>
      repo.upsert({ path: projectPath, worktreePolicy: 'sometimes' as never }),
    ).toThrow(/worktree|policy/i);
  });

  it('stores a verify-command override and clears it with an empty string', () => {
    const set = repo.upsert({ path: projectPath, verifyCommand: 'bun test' });
    expect(set.verifyCommand).toBe('bun test');
    const cleared = repo.upsert({ path: projectPath, verifyCommand: '' });
    expect(cleared.verifyCommand).toBeNull();
  });

  it('defaults verifyAutoSteer to inherit and verifyMaxRounds to null on a new row', () => {
    const p = repo.upsert({ path: projectPath });
    expect(p.verifyAutoSteer).toBe('inherit');
    expect(p.verifyMaxRounds).toBeNull();
  });

  it('accepts the tri-state verifyAutoSteer values and rejects garbage', () => {
    for (const value of ['on', 'off', 'inherit'] as const) {
      const p = repo.upsert({ path: `${projectPath}-${value}`, verifyAutoSteer: value });
      expect(p.verifyAutoSteer).toBe(value);
      repo.delete(`${projectPath}-${value}`);
    }
    expect(() =>
      repo.upsert({ path: projectPath, verifyAutoSteer: 'maybe' as never }),
    ).toThrow(/auto.?steer/i);
  });

  it('stores a nullable verifyMaxRounds and rejects a negative / non-integer value', () => {
    const set = repo.upsert({ path: projectPath, verifyMaxRounds: 5 });
    expect(set.verifyMaxRounds).toBe(5);
    const cleared = repo.upsert({ path: projectPath, verifyMaxRounds: null });
    expect(cleared.verifyMaxRounds).toBeNull();
    expect(() => repo.upsert({ path: projectPath, verifyMaxRounds: -1 })).toThrow(/rounds/i);
    expect(() => repo.upsert({ path: projectPath, verifyMaxRounds: 2.5 })).toThrow(/rounds/i);
  });

  it('patches the auto-steer fields without touching the others', () => {
    repo.upsert({ path: projectPath, verifyAutoSteer: 'on', verifyMaxRounds: 4, name: 'keep' });
    const patched = repo.upsert({ path: projectPath, verifyAutoSteer: 'off' });
    expect(patched.verifyAutoSteer).toBe('off');
    expect(patched.verifyMaxRounds).toBe(4); // untouched
    expect(patched.name).toBe('keep');
  });

  it('patches a subset — omitted fields are left unchanged, not nulled', () => {
    repo.upsert({ path: projectPath, defaultEngine: 'pi', verifyCommand: 'make check' });
    // Patch only the name; engine + verify must survive.
    const patched = repo.upsert({ path: projectPath, name: 'renamed' });
    expect(patched.name).toBe('renamed');
    expect(patched.defaultEngine).toBe('pi');
    expect(patched.verifyCommand).toBe('make check');
  });

  it('prefers an explicit name over the derived basename', () => {
    const p = repo.upsert({ path: projectPath, name: 'My Service' });
    expect(p.name).toBe('My Service');
  });

  it('clearing the name with an empty string reverts to the derived basename', () => {
    repo.upsert({ path: projectPath, name: 'Custom Name' });
    // Per patch semantics, '' clears the override → back to basename(path).
    const cleared = repo.upsert({ path: projectPath, name: '' });
    expect(cleared.name).toBe('repo');
  });

  it('allows a config row for a path that does not exist on disk', () => {
    // Config is declarative — unlike recent_projects.list, existence is a runtime
    // concern, not a precondition for holding config.
    const p = repo.upsert({ path: '/does/not/exist/on/disk/repo' });
    expect(p.path).toBe('/does/not/exist/on/disk/repo');
    expect(repo.findByPath('/does/not/exist/on/disk/repo')).not.toBeNull();
    repo.delete('/does/not/exist/on/disk/repo');
  });

  it('a project with only a path is valid — all config fields inherit (null)', () => {
    const p = repo.upsert({ path: projectPath });
    expect(p.defaultEngine).toBeNull();
    expect(p.worktreePolicy).toBeNull();
    expect(p.verifyCommand).toBeNull();
  });

  it('findByPath returns null for an unknown project (soft reference, no throw)', () => {
    expect(repo.findByPath('/never/configured/repo')).toBeNull();
  });

  it('deletes a config row without touching anything else', () => {
    repo.upsert({ path: projectPath });
    repo.delete(projectPath);
    expect(repo.findByPath(projectPath)).toBeNull();
  });
});
