import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import { SchedulerService } from '../../../src/scheduler/scheduler.service';
import { SchedulesRepository } from '../../../src/scheduler/schedules.repository';

const SERVER_ROOT = process.cwd();
const CHILD = join(SERVER_ROOT, 'test/unit/scheduler/scheduler-cross-process-child.ts');

interface ChildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}

function at(hour: number, minute: number): number {
  return new Date(2026, 6, 22, hour, minute, 0, 0).getTime();
}

async function runChild(args: string[]): Promise<ChildResult> {
  const child = Bun.spawn([process.execPath, CHILD, ...args], {
    cwd: SERVER_ROOT,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const line = stdout.trim().split('\n').filter(Boolean).at(-1);
  let json: Record<string, unknown> | null = null;
  if (line) {
    try {
      json = JSON.parse(line) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  return { exitCode, stdout, stderr, json };
}

function expectChildSuccess(result: ChildResult): void {
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: '' });
  expect(result.json).not.toBeNull();
}

describe('Scheduler cross-process SQLite ownership', () => {
  let dataDir = '';
  let gateDir = '';

  afterEach(() => {
    delete process.env.NUNCIO_DATA_DIR;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (gateDir) rmSync(gateDir, { recursive: true, force: true });
    dataDir = '';
    gateDir = '';
  });

  it('atomically claims one due cursor when two processes hold the same stale schedule snapshot', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-cursor-race-'));
    gateDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-cursor-gate-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    const database = new DatabaseService();
    const scheduler = new SchedulerService(new SchedulesRepository(database));
    scheduler.clock = { now: () => at(8, 0) };
    const schedule = scheduler.create({
      kind: 'cron',
      spec: 'daily@09:00',
      target: { kind: 'system', job: 'infra' },
    });
    scheduler.onModuleDestroy();
    database.onModuleDestroy();

    const args = [
      'intent-race', dataDir, '', gateDir, schedule.id, String(at(9, 0)), String(at(9, 0) + 86_400_000),
    ];
    const [first, second] = await Promise.all([
      runChild(args.map((value, index) => index === 2 ? 'a' : value)),
      runChild(args.map((value, index) => index === 2 ? 'b' : value)),
    ]);
    expectChildSuccess(first);
    expectChildSuccess(second);

    expect([first.json?.status, second.json?.status].sort()).toEqual(['created', 'lost']);
    process.env.NUNCIO_DATA_DIR = dataDir;
    const reopened = new DatabaseService();
    try {
      const intents = reopened.db.prepare<{ count: number }, []>(
        'SELECT COUNT(*) AS count FROM schedule_dispatch_intents',
      ).get()?.count ?? 0;
      expect(intents).toBe(1);
      expect(new SchedulesRepository(reopened).findById(schedule.id)?.nextFireAt).toBe(at(9, 0) + 86_400_000);
    } finally {
      reopened.onModuleDestroy();
    }
  });

  it('leases a pending system intent before either competing boot invokes its handler', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-system-race-'));
    gateDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-system-gate-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    const database = new DatabaseService();
    const schedules = new SchedulesRepository(database);
    const scheduler = new SchedulerService(schedules);
    scheduler.clock = { now: () => at(8, 0) };
    const schedule = scheduler.create({
      kind: 'heartbeat',
      spec: 'every:15m',
      target: { kind: 'system', job: 'infra' },
    });
    schedules.dispatches.begin(schedule, at(8, 15), 'ok', at(8, 30), null);
    database.db.exec(`
      CREATE TABLE scheduler_system_invocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        job TEXT NOT NULL
      )
    `);
    scheduler.onModuleDestroy();
    database.onModuleDestroy();

    const [first, second] = await Promise.all([
      runChild(['system-recovery', dataDir, 'a', gateDir]),
      runChild(['system-recovery', dataDir, 'b', gateDir]),
    ]);
    expectChildSuccess(first);
    expectChildSuccess(second);

    process.env.NUNCIO_DATA_DIR = dataDir;
    const reopened = new DatabaseService();
    try {
      const invocations = reopened.db.prepare<{ owner: string; job: string }, []>(
        'SELECT owner, job FROM scheduler_system_invocations ORDER BY id',
      ).all();
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.job).toBe('infra');
      expect(reopened.db.prepare<{ status: string }, []>(
        'SELECT status FROM schedule_dispatch_intents',
      ).get()?.status).toBe('completed');
    } finally {
      reopened.onModuleDestroy();
    }
  });
});
