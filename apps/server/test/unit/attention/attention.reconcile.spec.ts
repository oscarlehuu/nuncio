import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { AttentionRepository } from '../../../src/attention/attention.repository';
import { AttentionService } from '../../../src/attention/attention.service';
import type { RaiseSignal } from '../../../src/attention/attention.types';

/**
 * Boot reconciliation (decision #3 — persist + reconcile) — RED until implemented.
 * On restart, open items are re-checked against live state: a condition that
 * cleared while the daemon was down is auto-resolved; a still-live one stays open.
 * The attention analogue of rung-2 reconcilePendingRuns.
 */
describe('AttentionService boot reconciliation', () => {
  let module: TestingModule;
  let svc: AttentionService;
  let dataDir: string;
  let now = 1_000;

  const signal = (over: Partial<RaiseSignal> = {}): RaiseSignal => ({
    kind: over.kind ?? 'tripped-breaker',
    subjectId: over.subjectId ?? 'loop-1',
    projectPath: over.projectPath ?? '/repos/x',
    title: over.title ?? 'Loop broke',
    payload: over.payload ?? null,
  });

  async function boot(): Promise<void> {
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [AttentionRepository, AttentionService],
    }).compile();
    svc = module.get(AttentionService);
    svc.clock = { now: () => now };
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-attention-reconcile-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    now = 1_000;
    await boot();
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('auto-resolves an item whose condition cleared while the daemon was down', async () => {
    const item = svc.raise(signal({ subjectId: 'loop-1' }));
    await module.close();

    // Restart. The loop resumed on another process → its condition is gone.
    process.env.NUNCIO_DATA_DIR = dataDir;
    now = 9_000;
    await boot();
    svc.registerProbe('tripped-breaker', () => false);
    svc.reconcileOpenItems();

    expect(svc.list().items.some((i) => i.id === item.id)).toBe(false);
  });

  it('keeps a still-live item open across a restart', async () => {
    const item = svc.raise(signal());
    await module.close();

    process.env.NUNCIO_DATA_DIR = dataDir;
    await boot();
    svc.registerProbe('tripped-breaker', () => true); // condition still holds
    svc.reconcileOpenItems();

    expect(svc.list().items.some((i) => i.id === item.id)).toBe(true);
  });

  it('preserves founder ack state across a restart (ack survives)', async () => {
    const item = svc.raise(signal());
    now = 2_000;
    svc.acknowledge(item.id);
    await module.close();

    process.env.NUNCIO_DATA_DIR = dataDir;
    await boot();
    const reloaded = svc.list().items.find((i) => i.id === item.id);
    expect(reloaded?.acknowledgedAt).toBe(2_000);
  });
});
