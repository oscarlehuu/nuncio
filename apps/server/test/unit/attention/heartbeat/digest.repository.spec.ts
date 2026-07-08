import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../../src/db/database.module';
import { DigestRepository } from '../../../../src/attention/heartbeat/digest.repository';
import type { Digest } from '../../../../src/attention/heartbeat/heartbeat.types';

/**
 * Durable digest markers (ADR-006) — RED until implemented. The marker is what
 * makes a digest not-double-sent on a missed-fire catch-up and carries the
 * since-last window across a restart.
 */
function digest(over: Partial<Digest> = {}): Digest {
  return {
    variant: over.variant ?? 'morning',
    windowFrom: over.windowFrom ?? 0,
    windowTo: over.windowTo ?? 1_000,
    loops: over.loops ?? { runsOk: 1, runsFailed: 0, prsOpened: 0 },
    attention: over.attention ?? { raised: 0, resolved: 0, openTopCount: 0 },
    sessions: over.sessions ?? { completed: 0, needsYou: 0 },
    budget: over.budget ?? { runsToday: 0, cap: 24 },
    highlights: over.highlights ?? [],
    projectLines: over.projectLines ?? [],
  };
}

describe('DigestRepository', () => {
  let module: TestingModule;
  let repo: DigestRepository;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-digest-repo-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [DigestRepository],
    }).compile();
    repo = module.get(DigestRepository);
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('marks a slot sent and reads it back', () => {
    const dto = repo.markSent({
      slotKey: '2026-07-07:morning',
      variant: 'morning',
      sentAt: 5_000,
      windowFrom: 0,
      windowTo: 5_000,
      digest: digest(),
    });
    expect(dto.slotKey).toBe('2026-07-07:morning');
    expect(repo.wasSent('2026-07-07:morning')).toBe(true);
    expect(repo.wasSent('2026-07-07:evening')).toBe(false);
  });

  it('is idempotent — a second markSent of the same slot does not duplicate', () => {
    repo.markSent({ slotKey: 's1', variant: 'morning', sentAt: 1, windowFrom: 0, windowTo: 1, digest: digest() });
    repo.markSent({ slotKey: 's1', variant: 'morning', sentAt: 2, windowFrom: 0, windowTo: 2, digest: digest() });
    expect(repo.wasSent('s1')).toBe(true);
    expect(repo.findBySlot('s1')).not.toBeNull();
  });

  it('latest() returns the most-recently-sent marker (drives the since-last window)', () => {
    repo.markSent({ slotKey: 'a', variant: 'morning', sentAt: 1_000, windowFrom: 0, windowTo: 1_000, digest: digest() });
    repo.markSent({ slotKey: 'b', variant: 'evening', sentAt: 9_000, windowFrom: 1_000, windowTo: 9_000, digest: digest({ variant: 'evening' }) });
    expect(repo.latest()!.slotKey).toBe('b');
    expect(repo.latest()!.windowTo).toBe(9_000);
  });

  it('persists markers across a restart (durable since-last window)', async () => {
    repo.markSent({ slotKey: 'survivor', variant: 'morning', sentAt: 3_000, windowFrom: 0, windowTo: 3_000, digest: digest() });
    await module.close();
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [DigestRepository],
    }).compile();
    repo = module.get(DigestRepository);
    expect(repo.wasSent('survivor')).toBe(true);
    expect(repo.latest()!.windowTo).toBe(3_000);
  });
});
