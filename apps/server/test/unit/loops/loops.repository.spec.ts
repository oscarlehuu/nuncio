import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { LoopsRepository } from '../../../src/loops/loops.repository';

/**
 * Durable loops + loop_runs (ADR-006). RED until the tables + repository exist.
 * Counting derives from these rows, so their durability is the restart heart.
 */
describe('LoopsRepository', () => {
  let module: TestingModule;
  let repo: LoopsRepository;
  let dataDir: string;

  const base = () => ({
    goal: 'bump dependencies',
    scheduleId: 'sched-1',
    maxRunsPerDay: 3,
    maxConsecutiveFailures: 3,
    stopJson: null,
    escalation: 'needs-attention',
    projectPath: '/repos/x',
  });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-loops-repo-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [LoopsRepository],
    }).compile();
    repo = module.get(LoopsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('creates a loop with the 5 fields and reads it back (status active)', () => {
    const loop = repo.create(base());
    expect(loop.id).toBeTruthy();
    expect(loop.goal).toBe('bump dependencies');
    expect(loop.scheduleId).toBe('sched-1');
    expect(loop.maxRunsPerDay).toBe(3);
    expect(loop.maxConsecutiveFailures).toBe(3);
    expect(loop.stop).toBeNull();
    expect(loop.escalation).toBe('needs-attention');
    expect(loop.projectPath).toBe('/repos/x');
    expect(loop.status).toBe('active');
    expect(repo.findById(loop.id)).not.toBeNull();
  });

  it('persists a maxTotalRuns stop condition round-trip', () => {
    const loop = repo.create({ ...base(), stopJson: JSON.stringify({ kind: 'maxTotalRuns', n: 5 }) });
    expect(repo.findById(loop.id)!.stop).toEqual({ kind: 'maxTotalRuns', n: 5 });
  });

  it('persists a model round-trip and defaults it to null', () => {
    const withModel = repo.create({ ...base(), engine: 'mock', model: 'mock-model' });
    expect(withModel.model).toBe('mock-model');
    expect(repo.findById(withModel.id)!.model).toBe('mock-model');
    expect(repo.create(base()).model).toBeNull();
  });

  it('update sets, clears, and leaves the model untouched (gated SET)', () => {
    const loop = repo.create({ ...base(), model: 'm1' });
    expect(repo.update(loop.id, { model: 'm2' })!.model).toBe('m2');
    // Omitted key → untouched.
    expect(repo.update(loop.id, { goal: 'other goal' })!.model).toBe('m2');
    // Explicit null clears (back to the provider default).
    expect(repo.update(loop.id, { model: null })!.model).toBeNull();
  });

  it('lists loops and updates status', () => {
    const before = repo.list().length;
    const loop = repo.create(base());
    expect(repo.list().length).toBe(before + 1);
    repo.setStatus(loop.id, 'broken');
    expect(repo.findById(loop.id)!.status).toBe('broken');
  });

  it('appends run rows and lists them in order', () => {
    const loop = repo.create(base());
    repo.appendRun({ loopId: loop.id, taskId: 't1', outcome: 'ok', dayBucket: '2026-07-07' });
    repo.appendRun({ loopId: loop.id, taskId: 't2', outcome: 'failed', dayBucket: '2026-07-07' });
    const runs = repo.listRuns(loop.id);
    expect(runs.map((r) => r.outcome)).toEqual(['ok', 'failed']);
    expect(runs[0]!.taskId).toBe('t1');
  });

  it('deletes a loop (run history handling per design)', () => {
    const loop = repo.create(base());
    repo.appendRun({ loopId: loop.id, taskId: 't', outcome: 'ok', dayBucket: '2026-07-07' });
    repo.delete(loop.id);
    expect(repo.findById(loop.id)).toBeNull();
  });

  it('rebuilds loops + runs after a restart (durable, ADR-006)', async () => {
    const seedDir = mkdtempSync(join(tmpdir(), 'nuncio-loops-restart-'));
    process.env.NUNCIO_DATA_DIR = seedDir;
    const first = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [LoopsRepository],
    }).compile();
    const created = first.get(LoopsRepository).create(base());
    first.get(LoopsRepository).appendRun({
      loopId: created.id,
      taskId: 't',
      outcome: 'failed',
      dayBucket: '2026-07-07',
    });
    await first.close();

    const second = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [LoopsRepository],
    }).compile();
    const rebuilt = second.get(LoopsRepository).findById(created.id);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.goal).toBe('bump dependencies');
    expect(second.get(LoopsRepository).listRuns(created.id).map((r) => r.outcome)).toEqual(['failed']);
    await second.close();
    rmSync(seedDir, { recursive: true, force: true });
    process.env.NUNCIO_DATA_DIR = dataDir;
  });
});
