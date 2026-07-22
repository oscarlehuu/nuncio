import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import { TasksRepository } from '../../../src/tasks/tasks.repository';

describe('Scheduler dispatch receipt context', () => {
  let dataDir = '';
  let database: DatabaseService | null = null;

  afterEach(() => {
    if (database && !database.closed) database.onModuleDestroy();
    database = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('isolates re-entrant receipts and clears context before later async work', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-scheduler-receipt-context-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    database = new DatabaseService();
    const tasks = new TasksRepository(database);
    let createLater!: () => void;
    const later = new Promise<void>((resolve) => { createLater = resolve; });

    database.withScheduleDispatchIntent('outer-intent', () => {
      tasks.create({ prompt: 'outer' });
      database!.withScheduleDispatchIntent('inner-intent', () => {
        tasks.create({ prompt: 'inner' });
      });
      void later.then(() => tasks.create({ prompt: 'later' }));
    });
    createLater();
    await later;
    await Promise.resolve();

    const rows = database.db.prepare<{
      prompt: string;
      schedule_dispatch_intent_id: string | null;
    }, []>('SELECT prompt, schedule_dispatch_intent_id FROM tasks ORDER BY rowid').all();
    expect(rows).toEqual([
      { prompt: 'outer', schedule_dispatch_intent_id: 'outer-intent' },
      { prompt: 'inner', schedule_dispatch_intent_id: 'inner-intent' },
      { prompt: 'later', schedule_dispatch_intent_id: null },
    ]);
    expect(() => database!.withScheduleDispatchIntent(
      'outer-intent',
      () => tasks.create({ prompt: 'duplicate outer' }),
    )).toThrow();
  });
});
