import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../../src/db/database.module';
import { DatabaseService } from '../../../../src/db/database.service';
import { HeartbeatHealthRepository } from '../../../../src/attention/heartbeat/heartbeat-health.repository';

/**
 * Durable per-job heartbeat health — one upserted row per system job so a
 * swallowed layer failure leaves an `error`/`timeout` fact instead of vanishing.
 */
describe('HeartbeatHealthRepository', () => {
  let module: TestingModule;
  let repo: HeartbeatHealthRepository;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-hb-health-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [HeartbeatHealthRepository],
    }).compile();
    repo = module.get(HeartbeatHealthRepository);
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('records a job run and reads it back', () => {
    repo.record('infra', 'ok', null, 1_000);
    expect(repo.findByJob('infra')).toEqual({ job: 'infra', lastRunAt: 1_000, outcome: 'ok', detail: null });
  });

  it('upserts by job — the latest run wins, one row per job', () => {
    repo.record('reconcile', 'ok', null, 1_000);
    repo.record('reconcile', 'error', 'boom', 2_000);
    expect(repo.list()).toEqual([
      { job: 'reconcile', lastRunAt: 2_000, outcome: 'error', detail: 'boom' },
    ]);
  });

  it('lists every job ordered stably', () => {
    repo.record('reconcile', 'ok', null, 1_000);
    repo.record('infra', 'timeout', 'layer exceeded 10000ms', 900);
    expect(repo.list().map((r) => r.job)).toEqual(['infra', 'reconcile']);
  });

  it('truncates a very long detail so the row stays small', () => {
    repo.record('digest-morning', 'error', 'x'.repeat(5_000), 1_000);
    expect(repo.findByJob('digest-morning')!.detail!.length).toBe(500);
  });

  it('is a no-op on a closed database (no throw)', () => {
    module.get(DatabaseService).onModuleDestroy();
    expect(() => repo.record('infra', 'ok', null, 1_000)).not.toThrow();
    expect(repo.list()).toEqual([]);
    expect(repo.findByJob('infra')).toBeNull();
  });

  it('returns an empty list before any run (not an error)', () => {
    expect(repo.list()).toEqual([]);
  });
});
