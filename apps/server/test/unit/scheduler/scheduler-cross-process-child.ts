import 'reflect-metadata';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import { SchedulerService } from '../../../src/scheduler/scheduler.service';
import { SchedulesRepository } from '../../../src/scheduler/schedules.repository';

const [mode, dataDir, role, gateDir, ...args] = process.argv.slice(2);
if (!mode || !dataDir || !role || !gateDir) {
  throw new Error('usage: <mode> <data-dir> <role> <gate-dir> [...args]');
}
if (role !== 'a' && role !== 'b') throw new Error(`invalid child role: ${role}`);

process.env.NUNCIO_DATA_DIR = dataDir;

function marker(name: string): string {
  return join(gateDir, `${role}.${name}`);
}

function siblingMarker(name: string): string {
  return join(gateDir, `${role === 'a' ? 'b' : 'a'}.${name}`);
}

async function waitFor(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(5);
  }
}

async function waitForIntentTerminal(database: DatabaseService, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const row = database.db.prepare<{ status: string }, []>(
      'SELECT status FROM schedule_dispatch_intents ORDER BY created_at, rowid LIMIT 1',
    ).get();
    if (row && row.status !== 'pending') return;
    if (Date.now() >= deadline) throw new Error('timed out waiting for intent settlement');
    await Bun.sleep(5);
  }
}

async function runIntentRace(): Promise<void> {
  const [scheduleId, firedAtRaw, nextFireAtRaw] = args;
  if (!scheduleId || !firedAtRaw || !nextFireAtRaw) throw new Error('missing intent-race args');
  const firedAt = Number(firedAtRaw);
  const nextFireAt = Number(nextFireAtRaw);
  if (!Number.isFinite(firedAt) || !Number.isFinite(nextFireAt)) {
    throw new Error('intent-race timestamps must be finite numbers');
  }
  const database = new DatabaseService();
  try {
    const schedules = new SchedulesRepository(database);
    const stale = schedules.findById(scheduleId);
    if (!stale) throw new Error(`schedule ${scheduleId} not found`);
    writeFileSync(marker('ready'), 'ready');
    await waitFor(siblingMarker('ready'));
    try {
      const intent = schedules.dispatches.begin(
        stale,
        firedAt,
        'ok',
        nextFireAt,
        null,
      );
      console.log(JSON.stringify({ status: 'created', intentId: intent.id }));
    } catch (error) {
      console.log(JSON.stringify({
        status: 'lost',
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  } finally {
    database.onModuleDestroy();
  }
}

async function runSystemRecovery(): Promise<void> {
  const database = new DatabaseService();
  const schedules = new SchedulesRepository(database);
  const scheduler = new SchedulerService(schedules);
  try {
    scheduler.setSystemFireHandler(async (job) => {
      database.db.prepare(
        'INSERT INTO scheduler_system_invocations (owner, job) VALUES (?, ?)',
      ).run(role, job);
      writeFileSync(marker('handler'), 'entered');
      const deadline = Date.now() + 500;
      while (!existsSync(siblingMarker('handler')) && Date.now() < deadline) {
        await Bun.sleep(5);
      }
    });
    scheduler.onModuleInit();
    writeFileSync(marker('ready'), 'ready');
    await waitFor(siblingMarker('ready'));
    scheduler.onApplicationBootstrap();
    await waitForIntentTerminal(database);
    const count = database.db.prepare<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM scheduler_system_invocations',
    ).get()?.count ?? 0;
    console.log(JSON.stringify({ status: 'completed', count }));
  } finally {
    scheduler.onModuleDestroy();
    database.onModuleDestroy();
  }
}

async function main(): Promise<void> {
  if (mode === 'intent-race') {
    await runIntentRace();
  } else if (mode === 'system-recovery') {
    await runSystemRecovery();
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
