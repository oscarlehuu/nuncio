import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../../src/db/database.module';
import { AttentionRepository } from '../../../../src/attention/attention.repository';
import { AttentionService } from '../../../../src/attention/attention.service';
import { AnomalyCollector } from '../../../../src/attention/fleet/anomaly-collector';

/**
 * Anomaly heuristics (rung 3 sub-phase C) — RED until implemented. EXACTLY two,
 * each raising through the A seam AND paired with a clear-path (no stale items).
 * Deterministic via injected clock + seam fakes over a real AttentionService.
 */
describe('AnomalyCollector', () => {
  let module: TestingModule;
  let attention: AttentionService;
  let collector: AnomalyCollector;
  let dataDir: string;

  const T = 30 * 60 * 1000;
  const N = 3;

  const open = (kind: string, subjectId: string) =>
    attention.list().items.some((i) => i.kind === kind && i.subjectId === subjectId);

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-anomaly-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [AttentionRepository, AttentionService, AnomalyCollector],
    }).compile();
    attention = module.get(AttentionService);
    collector = module.get(AnomalyCollector);
    collector.emptyDiffAgeMs = T;
    collector.loopFailingMinRuns = N;
    collector.runningSessions = () => [];
    collector.hasChanges = async () => false;
    collector.loopsToday = () => [];
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  describe('(a) session-empty-diff', () => {
    it('RUNNING > T with an empty diff raises the anomaly', async () => {
      collector.runningSessions = () => [{ id: 's1', projectPath: '/p', gitDir: '/wt', runningForMs: T + 1 }];
      collector.hasChanges = async () => false; // empty diff
      await collector.collectEmptyDiff();
      expect(open('session-empty-diff', 'session:s1')).toBe(true);
    });

    it('age exactly T is NOT anomalous (strict boundary)', async () => {
      collector.runningSessions = () => [{ id: 's1', projectPath: '/p', gitDir: '/wt', runningForMs: T }];
      await collector.collectEmptyDiff();
      expect(open('session-empty-diff', 'session:s1')).toBe(false);
    });

    it('RUNNING > T but a NON-empty diff is not anomalous (working, just slow)', async () => {
      collector.runningSessions = () => [{ id: 's1', projectPath: '/p', gitDir: '/wt', runningForMs: T + 1 }];
      collector.hasChanges = async () => true;
      await collector.collectEmptyDiff();
      expect(open('session-empty-diff', 'session:s1')).toBe(false);
    });

    it('the diff appearing mid-run CLEARS the item', async () => {
      collector.runningSessions = () => [{ id: 's1', projectPath: '/p', gitDir: '/wt', runningForMs: T + 1 }];
      collector.hasChanges = async () => false;
      await collector.collectEmptyDiff();
      expect(open('session-empty-diff', 'session:s1')).toBe(true);

      collector.hasChanges = async () => true; // agent finally changed something
      await collector.collectEmptyDiff();
      expect(open('session-empty-diff', 'session:s1')).toBe(false);
    });

    it('the session leaving RUNNING CLEARS the item', async () => {
      collector.runningSessions = () => [{ id: 's1', projectPath: '/p', gitDir: '/wt', runningForMs: T + 1 }];
      await collector.collectEmptyDiff();
      expect(open('session-empty-diff', 'session:s1')).toBe(true);

      collector.runningSessions = () => []; // finished
      await collector.collectEmptyDiff();
      expect(open('session-empty-diff', 'session:s1')).toBe(false);
    });
  });

  describe('(b) loop-failing', () => {
    const fail = { outcome: 'failed', verify: 'red' as const };
    const budget = { outcome: 'budget-exhausted', verify: 'none' as const };
    const okGreen = { outcome: 'ok', verify: 'green' as const };

    it('>= N today runs all failed/budget with no green raises the anomaly', () => {
      collector.loopsToday = () => [{ loopId: 'L1', projectPath: '/p', runs: [fail, budget, fail] }];
      collector.collectLoopFailing();
      expect(open('loop-failing', 'loop:L1')).toBe(true);
    });

    it('N-1 failing runs is NOT anomalous; the Nth trips it', () => {
      collector.loopsToday = () => [{ loopId: 'L1', projectPath: '/p', runs: [fail, fail] }]; // N-1
      collector.collectLoopFailing();
      expect(open('loop-failing', 'loop:L1')).toBe(false);
    });

    it('one green run today resets — no anomaly even with >= N runs', () => {
      collector.loopsToday = () => [{ loopId: 'L1', projectPath: '/p', runs: [fail, okGreen, fail] }];
      collector.collectLoopFailing();
      expect(open('loop-failing', 'loop:L1')).toBe(false);
    });

    it('a still-PENDING run today blocks the raise (it could still go green)', () => {
      const pending = { outcome: 'pending', verify: 'none' as const };
      // N fails + 1 unsettled → not yet "all failed today"; don't cry wolf.
      collector.loopsToday = () => [{ loopId: 'L1', projectPath: '/p', runs: [fail, fail, fail, pending] }];
      collector.collectLoopFailing();
      expect(open('loop-failing', 'loop:L1')).toBe(false);
    });

    it('once the pending run settles FAILED the anomaly raises', () => {
      collector.loopsToday = () => [{ loopId: 'L1', projectPath: '/p', runs: [fail, fail, fail, fail] }];
      collector.collectLoopFailing();
      expect(open('loop-failing', 'loop:L1')).toBe(true);
    });

    it('bookkeeping rows (budget-exhausted/skipped-overlap/resume) stay transparent', () => {
      // budget-exhausted counts as a failing consumed run; skipped-overlap/resume
      // are transparent and neither block nor trip the raise.
      const skip = { outcome: 'skipped-overlap', verify: 'none' as const };
      const resume = { outcome: 'resume', verify: 'none' as const };
      collector.loopsToday = () => [{ loopId: 'L1', projectPath: '/p', runs: [fail, budget, fail, skip, resume] }];
      collector.collectLoopFailing();
      expect(open('loop-failing', 'loop:L1')).toBe(true);
    });

    it('a green run after the anomaly raised CLEARS the item', () => {
      collector.loopsToday = () => [{ loopId: 'L1', projectPath: '/p', runs: [fail, fail, fail] }];
      collector.collectLoopFailing();
      expect(open('loop-failing', 'loop:L1')).toBe(true);

      collector.loopsToday = () => [{ loopId: 'L1', projectPath: '/p', runs: [fail, fail, fail, okGreen] }];
      collector.collectLoopFailing();
      expect(open('loop-failing', 'loop:L1')).toBe(false);
    });

    it('the loop dropping out of today (rollover / deleted) CLEARS the item', () => {
      collector.loopsToday = () => [{ loopId: 'L1', projectPath: '/p', runs: [fail, fail, fail] }];
      collector.collectLoopFailing();
      expect(open('loop-failing', 'loop:L1')).toBe(true);

      collector.loopsToday = () => []; // new day / loop gone
      collector.collectLoopFailing();
      expect(open('loop-failing', 'loop:L1')).toBe(false);
    });
  });

  it('sweep runs both heuristics', async () => {
    collector.runningSessions = () => [{ id: 's1', projectPath: '/p', gitDir: '/wt', runningForMs: T + 1 }];
    collector.loopsToday = () => [{ loopId: 'L1', projectPath: '/p', runs: [{ outcome: 'failed', verify: 'red' }, { outcome: 'failed', verify: 'red' }, { outcome: 'failed', verify: 'red' }] }];
    await collector.sweep();
    expect(open('session-empty-diff', 'session:s1')).toBe(true);
    expect(open('loop-failing', 'loop:L1')).toBe(true);
  });
});
