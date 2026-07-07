import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { AttentionRepository } from '../../../src/attention/attention.repository';

/**
 * Durable attention_items store (ADR-006) — RED until the repository is
 * implemented. The table itself is created by DatabaseService (guarded), so the
 * durability + dedup-index tests exercise real schema. Restart-safe: a rebuilt
 * module on the same DB must see the same rows.
 */
describe('AttentionRepository', () => {
  let module: TestingModule;
  let repo: AttentionRepository;
  let dataDir: string;

  const raise = (over: Partial<Parameters<AttentionRepository['raise']>[0]> = {}) => ({
    id: over.id ?? 'i1',
    kind: over.kind ?? 'tripped-breaker',
    subjectId: over.subjectId ?? 'loop-1',
    projectPath: over.projectPath ?? '/repos/x',
    severity: over.severity ?? 3,
    title: over.title ?? 'Loop broke',
    payloadJson: over.payloadJson ?? null,
    now: over.now ?? 1_000,
  });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-attention-repo-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [AttentionRepository],
    }).compile();
    repo = module.get(AttentionRepository);
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('creates an open item and reads it back', () => {
    const created = repo.raise(raise());
    expect(created.status).toBe('open');
    expect(repo.findById(created.id)!.subjectId).toBe('loop-1');
    expect(repo.findOpen('tripped-breaker', 'loop-1')!.id).toBe(created.id);
  });

  it('enforces ONE open row per (kind, subjectId) — re-raise does not stack', () => {
    repo.raise(raise({ id: 'i1', now: 1_000 }));
    // A second raise of the same condition bumps the existing open row (upsert),
    // never inserts a duplicate — DB partial-unique index guarantees it.
    repo.raise(raise({ id: 'i2', now: 2_000 }));
    expect(repo.list('open').filter((x) => x.subjectId === 'loop-1')).toHaveLength(1);
  });

  it('a resolved row does NOT block a fresh open item for the same condition', () => {
    const first = repo.raise(raise({ id: 'i1' }));
    repo.resolve(first.id, 2_000);
    // Condition re-occurs → a new open row is allowed (index is over open rows only).
    const second = repo.raise(raise({ id: 'i2', now: 3_000 }));
    expect(second.id).toBe('i2');
    expect(repo.list('open').filter((x) => x.subjectId === 'loop-1')).toHaveLength(1);
    expect(repo.list('resolved').filter((x) => x.subjectId === 'loop-1')).toHaveLength(1);
  });

  it('ack sets acknowledged_at and leaves the item OPEN', () => {
    const created = repo.raise(raise());
    const acked = repo.acknowledge(created.id, 5_000)!;
    expect(acked.acknowledgedAt).toBe(5_000);
    expect(acked.status).toBe('open');
  });

  it('resolve sets resolved_at and status resolved', () => {
    const created = repo.raise(raise());
    const resolved = repo.resolve(created.id, 6_000)!;
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).toBe(6_000);
  });

  it('persists items across a restart (rebuild module on the same DB)', async () => {
    const created = repo.raise(raise({ id: 'survivor' }));
    await module.close();
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [AttentionRepository],
    }).compile();
    repo = module.get(AttentionRepository);
    expect(repo.findById(created.id)!.status).toBe('open');
  });
});
