import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttentionRepository } from '../../../src/attention/attention.repository';
import { AttentionService } from '../../../src/attention/attention.service';
import { DatabaseService } from '../../../src/db/database.service';
import type { DispatcherProposal } from '../../../src/dispatcher/dispatcher-rules';
import { DispatcherService } from '../../../src/dispatcher/dispatcher.service';
import { TasksRepository } from '../../../src/tasks/tasks.repository';
import { TasksService } from '../../../src/tasks/tasks.service';

const NOW = new Date(2026, 6, 8, 20, 5).getTime();

const proposal = (overrides: Partial<DispatcherProposal> = {}): DispatcherProposal => ({
  subjectKey: overrides.subjectKey ?? 'attention:verify-dead:s1',
  title: overrides.title ?? 'Fix the failing verify in app',
  prompt: overrides.prompt ?? 'Fix the failing verify in app. Source: s1.',
  projectPath: overrides.projectPath ?? '/repo/app',
  engine: overrides.engine ?? 'cursor',
  model: overrides.model ?? 'cursor:test',
  rationale: overrides.rationale ?? 'source: open verify-dead attention item s1',
});

const approvalCorrelationKey = (proposalId: string, index: number): string =>
  `dispatcher:${proposalId}:${index}`;

describe('Dispatcher approval atomicity', () => {
  let dataDir: string;
  let database: DatabaseService;
  let items: AttentionRepository;
  let attention: AttentionService;
  let taskRows: TasksRepository;
  let tasks: TasksService;
  let dispatcher: DispatcherService;
  let observedStatusAtTaskStart: string | null;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-dispatcher-approval-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    database = new DatabaseService();
    items = new AttentionRepository(database);
    attention = new AttentionService(items);
    attention.clock = { now: () => NOW };
    taskRows = new TasksRepository(database);
    observedStatusAtTaskStart = null;
    const sessions = {
      get: () => null,
      create: () => {
        const proposalRow = items.list().find((item) => item.kind === 'dispatcher-proposal');
        observedStatusAtTaskStart = proposalRow?.status ?? null;
        return new Promise(() => {});
      },
    };
    const events = { listTail: () => [] };
    tasks = new TasksService(taskRows, sessions as never, events as never, database);
    dispatcher = new DispatcherService(attention, items, tasks);
    dispatcher.clock = { now: () => NOW };
  });

  afterEach(() => {
    tasks.onModuleDestroy();
    if (!database.closed) database.onModuleDestroy();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  function raiseProposal(proposals = [proposal()]): string {
    return attention.raise({
      kind: 'dispatcher-proposal',
      subjectId: 'dispatch:2026-07-08',
      title: 'Dispatcher proposal for 2026-07-08',
      payload: { proposals },
    }).id;
  }

  it('rolls back correlated task creation when proposal payload persistence fails', () => {
    const id = raiseProposal();
    items.updatePayload = () => { throw new Error('payload write failed'); };

    expect(() => dispatcher.approve(id)).toThrow('payload write failed');

    expect(taskRows.list()).toHaveLength(0);
    expect(items.findById(id)).toMatchObject({ status: 'open', payload: { proposals: [proposal()] } });
  });

  it('rolls back tasks and audit payload when proposal resolution fails, then retries once', () => {
    const id = raiseProposal();
    const resolve = attention.resolve.bind(attention);
    attention.resolve = () => { throw new Error('resolve write failed'); };

    expect(() => dispatcher.approve(id)).toThrow('resolve write failed');
    expect(taskRows.list()).toHaveLength(0);
    expect(items.findById(id)).toMatchObject({ status: 'open', payload: { proposals: [proposal()] } });

    attention.resolve = resolve;
    const retried = dispatcher.approve(id);
    expect(retried.taskIds).toHaveLength(1);
    expect(taskRows.list()).toHaveLength(1);
    expect(items.findById(id)).toMatchObject({ status: 'resolved', payload: { taskIds: retried.taskIds } });
  });

  it('reuses a uniquely correlated task from a legacy crash even after that task became terminal', () => {
    const id = raiseProposal();
    database.db.exec(`
      CREATE TABLE IF NOT EXISTS task_approval_correlations (
        correlation_key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    const existing = taskRows.create({
      prompt: proposal().prompt,
      provider: proposal().engine,
      model: proposal().model,
      projectPath: proposal().projectPath ?? undefined,
    });
    database.db.prepare(
      "UPDATE tasks SET status = 'DONE', finished_at = ?, updated_at = ? WHERE id = ?",
    ).run(NOW, NOW, existing.id);
    database.db.prepare(
      'INSERT INTO task_approval_correlations (correlation_key, task_id, created_at) VALUES (?, ?, ?)',
    ).run(approvalCorrelationKey(id, 0), existing.id, NOW);

    const approved = dispatcher.approve(id);

    expect(approved.taskIds).toEqual([existing.id]);
    expect(taskRows.list()).toHaveLength(1);
    expect(items.findById(id)?.status).toBe('resolved');
  });

  it('correlates duplicate proposal entries to one task without creating duplicate targets', () => {
    const duplicate = proposal();
    const id = raiseProposal([duplicate, { ...duplicate }]);

    const approved = dispatcher.approve(id);

    expect(approved.taskIds).toHaveLength(2);
    expect(new Set(approved.taskIds).size).toBe(1);
    expect(taskRows.list()).toHaveLength(1);
  });

  it('finishes resolution when taskIds were recorded before a legacy crash', () => {
    const id = raiseProposal();
    items.updatePayload(id, {
      proposals: [proposal()],
      approvedAt: NOW - 1,
      taskIds: ['task-existing'],
    }, NOW - 1);

    expect(dispatcher.approve(id)).toEqual({ proposalId: id, taskIds: ['task-existing'] });
    expect(items.findById(id)?.status).toBe('resolved');
    expect(taskRows.list()).toHaveLength(0);
  });

  it('commits proposal resolution before pumping tasks and keeps repeated approval idempotent', async () => {
    const id = raiseProposal([
      proposal(),
      proposal({ subjectKey: 'loop:one', prompt: 'Resume loop', engine: undefined, model: undefined }),
    ]);

    const first = dispatcher.approve(id);
    const second = dispatcher.approve(id);
    await Promise.resolve();

    expect(second).toEqual(first);
    expect(taskRows.list().map((task) => task.id).sort()).toEqual([...first.taskIds].sort());
    expect(observedStatusAtTaskStart).toBe('resolved');
    expect(items.findById(id)).toMatchObject({ status: 'resolved', payload: { taskIds: first.taskIds } });
  });
});
