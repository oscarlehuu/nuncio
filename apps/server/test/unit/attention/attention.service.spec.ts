import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { AttentionRepository } from '../../../src/attention/attention.repository';
import { AttentionService } from '../../../src/attention/attention.service';
import type { AttentionCounts, RaiseSignal } from '../../../src/attention/attention.types';

/**
 * Attention backbone service (rung 3 sub-phase A) — RED until implemented.
 * Deterministic via an injected clock. Dedup keeps one open item per condition;
 * ack mutes the badge without resolving; auto-resolve clears an item when its
 * condition lifts; manual resolve overrides a still-live condition.
 */
describe('AttentionService', () => {
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

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-attention-svc-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [AttentionRepository, AttentionService],
    }).compile();
    svc = module.get(AttentionService);
    now = 1_000;
    svc.clock = { now: () => now };
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  describe('raise + dedup', () => {
    it('raises an open item with the kind-derived severity + injected clock', () => {
      const item = svc.raise(signal());
      expect(item.status).toBe('open');
      expect(item.severity).toBe(3); // tripped-breaker
      expect(item.createdAt).toBe(1_000);
    });

    it('re-raising the same condition is idempotent — no second open item', () => {
      svc.raise(signal());
      now = 2_000;
      svc.raise(signal());
      const open = svc.list().items.filter((i) => i.subjectId === 'loop-1');
      expect(open).toHaveLength(1);
    });

    it('distinct conditions on the same subject are separate items', () => {
      svc.raise(signal({ kind: 'tripped-breaker', subjectId: 'loop-1' }));
      svc.raise(signal({ kind: 'anomaly', subjectId: 'loop-1' }));
      expect(svc.list().items.filter((i) => i.subjectId === 'loop-1')).toHaveLength(2);
    });

    it('rejects a malformed signal (missing kind or subjectId) at the boundary', () => {
      expect(() => svc.raise(signal({ kind: '' }))).toThrow(BadRequestException);
      expect(() => svc.raise(signal({ subjectId: '' }))).toThrow(BadRequestException);
    });

    it('tolerates an unknown/legacy kind (severity 0), never throwing', () => {
      const item = svc.raise(signal({ kind: 'future-kind' }));
      expect(item.severity).toBe(0);
    });
  });

  describe('auto-resolve on condition-clear', () => {
    it('reconcile auto-resolves an item whose condition cleared (probe false)', () => {
      const item = svc.raise(signal({ subjectId: 'loop-1' }));
      // The loop resumed → its condition no longer holds.
      svc.registerProbe('tripped-breaker', () => false);
      now = 5_000;
      svc.reconcileOpenItems();
      const reloaded = svc.list().items.find((i) => i.id === item.id);
      expect(reloaded).toBeUndefined(); // no longer open
    });

    it('keeps an item open while its condition still holds (probe true)', () => {
      const item = svc.raise(signal());
      svc.registerProbe('tripped-breaker', () => true);
      svc.reconcileOpenItems();
      expect(svc.list().items.some((i) => i.id === item.id)).toBe(true);
    });

    it('a condition that re-occurs after resolve yields a FRESH open item', () => {
      const first = svc.raise(signal());
      svc.resolve(first.id);
      now = 7_000;
      const second = svc.raise(signal());
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe('open');
    });
  });

  describe('ack / resolve semantics', () => {
    it('ack marks acknowledged but leaves the item OPEN and ranked', () => {
      const item = svc.raise(signal());
      now = 3_000;
      const acked = svc.acknowledge(item.id);
      expect(acked.acknowledgedAt).toBe(3_000);
      expect(acked.status).toBe('open');
      expect(svc.list().items.some((i) => i.id === item.id)).toBe(true);
    });

    it('manual resolve overrides a still-live condition (founder override)', () => {
      const item = svc.raise(signal());
      svc.registerProbe('tripped-breaker', () => true); // condition still live
      const resolved = svc.resolve(item.id);
      expect(resolved.status).toBe('resolved');
    });

    it('ack / resolve an unknown id → 404', () => {
      expect(() => svc.acknowledge('nope')).toThrow(NotFoundException);
      expect(() => svc.resolve('nope')).toThrow(NotFoundException);
    });

    it('resolving an already-resolved item is idempotent (returns the resolved row)', () => {
      const item = svc.raise(signal());
      const once = svc.resolve(item.id);
      const twice = svc.resolve(item.id);
      expect(twice.status).toBe('resolved');
      expect(twice.resolvedAt).toBe(once.resolvedAt);
    });
  });

  describe('counts (badge source) + change seam', () => {
    it('counts.unacked excludes acked items; total counts all open', () => {
      const a = svc.raise(signal({ kind: 'permission', subjectId: 's1' }));
      svc.raise(signal({ kind: 'anomaly', subjectId: 's2' }));
      let counts = svc.counts();
      expect(counts.total).toBe(2);
      expect(counts.unacked).toBe(2);
      svc.acknowledge(a.id);
      counts = svc.counts();
      expect(counts.total).toBe(2); // still open
      expect(counts.unacked).toBe(1); // acked one muted
    });

    it('counts drop to zero after resolve', () => {
      const item = svc.raise(signal());
      svc.resolve(item.id);
      expect(svc.counts().total).toBe(0);
    });

    it('emits a badge change on raise / ack / resolve (onChange seam, no polling)', () => {
      const emitted: AttentionCounts[] = [];
      svc.onChange = (c) => emitted.push(c);
      const item = svc.raise(signal());
      svc.acknowledge(item.id);
      svc.resolve(item.id);
      expect(emitted.length).toBeGreaterThanOrEqual(3);
      expect(emitted.at(-1)!.total).toBe(0);
    });
  });

  describe('list ordering', () => {
    it('returns items in ranked order (permission before anomaly)', () => {
      svc.raise(signal({ kind: 'anomaly', subjectId: 's-low' }));
      svc.raise(signal({ kind: 'permission', subjectId: 's-high' }));
      const ids = svc.list().items.map((i) => i.subjectId);
      expect(ids.indexOf('s-high')).toBeLessThan(ids.indexOf('s-low'));
    });
  });
});
