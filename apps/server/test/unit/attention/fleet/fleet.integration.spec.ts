import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../../src/db/database.module';
import { AttentionRepository } from '../../../../src/attention/attention.repository';
import { AttentionService } from '../../../../src/attention/attention.service';
import { AnomalyCollector } from '../../../../src/attention/fleet/anomaly-collector';
import { AttentionCollectors } from '../../../../src/attention/attention-collectors';

/**
 * Sub-phase C wiring: the anomaly collector registers into the AttentionCollectors
 * sweep so it runs on the 15-min cadence, and its items land in the real queue.
 */
describe('AnomalyCollector wiring', () => {
  let module: TestingModule;
  let anomaly: AnomalyCollector;
  let collectors: AttentionCollectors;
  let attention: AttentionService;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-fleet-int-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [AttentionRepository, AttentionService, AttentionCollectors, AnomalyCollector],
    }).compile();
    attention = module.get(AttentionService);
    anomaly = module.get(AnomalyCollector);
    collectors = module.get(AttentionCollectors);
    // Register the anomaly sweep into the collectors' sweep (as onModuleInit does).
    anomaly.onModuleInit();
    collectors.onModuleInit();
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('a registered anomaly sweep runs when AttentionCollectors.sweep() fires', async () => {
    // Drive the anomaly heuristic via its seams; the AttentionCollectors sweep must
    // invoke it (the 15-min cadence hook).
    anomaly.emptyDiffAgeMs = 10;
    anomaly.runningSessions = () => [{ id: 's1', projectPath: '/p', gitDir: '/wt', runningForMs: 100 }];
    anomaly.hasChanges = async () => false;
    anomaly.loopsToday = () => [];

    await collectors.sweep();

    expect(attention.list().items.some((i) => i.kind === 'session-empty-diff' && i.subjectId === 'session:s1')).toBe(true);
  });
});
