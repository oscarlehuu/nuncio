import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { SchedulesRepository } from '../../../src/scheduler/schedules.repository';
import type { CreateScheduleDto } from '../../../src/scheduler/scheduler.types';

/**
 * Durable schedule state (ADR-006). RED until the schedules table + repository
 * exist. Fire-history + next_fire_at survive restart with no in-memory truth.
 */
describe('SchedulesRepository', () => {
  let module: TestingModule;
  let repo: SchedulesRepository;
  let dataDir: string;

  const cron = (spec: string, nextFireAt: number | null): CreateScheduleDto & { nextFireAt: number | null } => ({
    kind: 'cron',
    spec,
    target: { kind: 'task', template: { prompt: 'nightly maintenance' } },
    nextFireAt,
  });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-schedules-repo-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [SchedulesRepository],
    }).compile();
    repo = module.get(SchedulesRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('creates a schedule and reads it back with its target + next fire', () => {
    const s = repo.create(cron('daily@02:00', 1_000_000));
    expect(s.id).toBeTruthy();
    expect(s.kind).toBe('cron');
    expect(s.spec).toBe('daily@02:00');
    expect(s.target).toEqual({ kind: 'task', template: { prompt: 'nightly maintenance' } });
    expect(s.enabled).toBe(true);
    expect(s.nextFireAt).toBe(1_000_000);
    expect(repo.findById(s.id)).not.toBeNull();
  });

  it('lists all schedules', () => {
    const before = repo.list().length;
    repo.create(cron('every:30m', 2_000_000));
    expect(repo.list().length).toBe(before + 1);
  });

  it('listDue returns only enabled schedules with next_fire_at <= now', () => {
    const due = repo.create(cron('daily@01:00', 500));
    const future = repo.create(cron('daily@01:00', 9_999_999_999_999));
    const ids = repo.listDue(1000).map((s) => s.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(future.id);
  });

  it('a disabled schedule is never due', () => {
    const s = repo.create(cron('daily@01:00', 500));
    repo.setEnabled(s, false, null);
    expect(repo.listDue(1000).map((x) => x.id)).not.toContain(s.id);
  });

  it('records a fire: last_fire_at + last_result + advanced next_fire_at', () => {
    const s = repo.create(cron('daily@01:00', 500));
    repo.recordFire(s, 1234, 'ok', 88_888);
    const after = repo.findById(s.id)!;
    expect(after.lastFireAt).toBe(1234);
    expect(after.lastResult).toBe('ok');
    expect(after.nextFireAt).toBe(88_888);
  });

  it('records a skipped-overlap / missed / error result verbatim', () => {
    const s = repo.create(cron('daily@01:00', 500));
    repo.recordFire(s, 10, 'skipped-overlap', 20);
    expect(repo.findById(s.id)!.lastResult).toBe('skipped-overlap');
    repo.recordFire(repo.findById(s.id)!, 30, 'missed', 40);
    expect(repo.findById(s.id)!.lastResult).toBe('missed');
    repo.recordFire(repo.findById(s.id)!, 50, 'error:boom', 60);
    expect(repo.findById(s.id)!.lastResult).toBe('error:boom');
  });

  it('setNextFire updates only the next fire (for boot rehydration)', () => {
    const s = repo.create(cron('daily@01:00', 500));
    repo.setNextFire(s, 777);
    expect(repo.findById(s.id)!.nextFireAt).toBe(777);
  });

  it('fences nullable and zero next-fire cursors with generation-aware CAS', () => {
    const zero = repo.create(cron('daily@01:00', 0));
    expect(repo.setNextFire(zero, 1)).toBe(true);
    expect(repo.setNextFire(zero, 2)).toBe(false);
    expect(repo.findById(zero.id)!.nextFireAt).toBe(1);

    const nullable = repo.create(cron('daily@01:00', null));
    expect(repo.setNextFire(nullable, 0)).toBe(true);
    expect(repo.setNextFire(nullable, 2)).toBe(false);
    expect(repo.findById(nullable.id)!.nextFireAt).toBe(0);
  });

  it('deletes a schedule', () => {
    const s = repo.create(cron('daily@01:00', 500));
    repo.delete(s.id);
    expect(repo.findById(s.id)).toBeNull();
  });

  it('rebuilds every schedule row after a restart (durable, ADR-006)', async () => {
    const seedDir = mkdtempSync(join(tmpdir(), 'nuncio-schedules-restart-'));
    process.env.NUNCIO_DATA_DIR = seedDir;
    const first = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [SchedulesRepository],
    }).compile();
    const created = first.get(SchedulesRepository).create(cron('daily@03:00', 4242));
    await first.close();

    const second = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [SchedulesRepository],
    }).compile();
    const rebuilt = second.get(SchedulesRepository).findById(created.id);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.spec).toBe('daily@03:00');
    expect(rebuilt!.nextFireAt).toBe(4242);
    await second.close();
    rmSync(seedDir, { recursive: true, force: true });
    process.env.NUNCIO_DATA_DIR = dataDir;
  });
});
