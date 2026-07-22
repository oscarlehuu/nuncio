import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import type { SessionDto, SessionEvent } from '../../../src/sessions/domain/sessions.types';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsService } from '../../../src/sessions/sessions.service';
import { TasksRepository } from '../../../src/tasks/tasks.repository';
import { TasksService } from '../../../src/tasks/tasks.service';

interface SessionFakeOptions {
  parentId: string;
  failDigestAppends?: boolean;
  appendAttempts?: { count: number };
}

function parentDto(id: string): SessionDto {
  return {
    id,
    title: 'Parent',
    status: 'IDLE',
    provider: 'cursor',
    model: null,
    modelOptions: null,
    mode: null,
    workspace: null,
    prompt: 'parent',
    preview: null,
    projectPath: null,
    baseBranch: null,
    worktreePath: null,
    branch: null,
    providerThreadId: null,
    providerActiveTurnId: null,
    providerState: null,
    runtimePolicy: null,
    verifyOwner: 'session',
    mcpServerIds: null,
    cursorBackend: null,
    cursorChatId: null,
    parentSessionId: null,
    originTaskId: null,
    priorSessionId: null,
    supportsInteraction: false,
    forgeProvider: null,
    pullRequestUrl: null,
    pullRequestNumber: null,
    pullRequestState: null,
    forgeStatus: 'none',
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SessionDto;
}

function fakeSessions(
  events: EventsRepository,
  options: SessionFakeOptions,
): SessionsService {
  const append = (sessionId: string, type: string, payload: unknown): SessionEvent => {
    if (type === 'task_completed') {
      if (options.appendAttempts) options.appendAttempts.count += 1;
      if (options.failDigestAppends) throw new Error('first-boot digest append failed');
    }
    return events.append(sessionId, type, payload, false);
  };

  return {
    get: (id: string) => id === options.parentId ? parentDto(id) : null,
    flushParentBuffer: () => {},
    appendOrchestrationEvent: append,
    persistOrchestrationEvent: append,
    emitPersistedEvent: (sessionId: string, event: SessionEvent) => {
      events.notifyPersisted(sessionId, event);
    },
    steerQueueRepository: { countByOrigin: () => 0 },
  } as unknown as SessionsService;
}

function seedParent(database: DatabaseService, parentId: string): void {
  database.db.prepare(
    `INSERT INTO sessions
       (id, title, status, provider, prompt, created_at, updated_at)
     VALUES (?, 'Parent', 'IDLE', 'cursor', 'parent', 1, 1)`,
  ).run(parentId);
}

function openBoot(
  dataDir: string,
  parentId: string,
  options: Omit<SessionFakeOptions, 'parentId'> = {},
): {
  database: DatabaseService;
  events: EventsRepository;
  repository: TasksRepository;
  service: TasksService;
} {
  process.env.NUNCIO_DATA_DIR = dataDir;
  const database = new DatabaseService();
  const events = new EventsRepository(database);
  const repository = new TasksRepository(database);
  const service = new TasksService(
    repository,
    fakeSessions(events, { parentId, ...options }),
    events,
    database,
  );
  return { database, events, repository, service };
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

describe('task boot reconciliation outbox', () => {
  const dirs: string[] = [];

  afterEach(() => {
    delete process.env.NUNCIO_DATA_DIR;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('replays a failed first-boot digest once after reopening the same database', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nuncio-task-reconcile-'));
    dirs.push(dataDir);
    const parentId = 'parent-reconcile';

    process.env.NUNCIO_DATA_DIR = dataDir;
    const seedDb = new DatabaseService();
    seedParent(seedDb, parentId);
    const seedTasks = new TasksRepository(seedDb);
    const child = seedTasks.create({
      prompt: 'interrupted child',
      role: 'subagent',
      parentSessionId: parentId,
    });
    expect(seedTasks.claimNextQueued()?.id).toBe(child.id);
    seedDb.onModuleDestroy();

    const attempts = { count: 0 };
    const first = openBoot(dataDir, parentId, {
      failDigestAppends: true,
      appendAttempts: attempts,
    });
    await waitFor(() => attempts.count > 0, 'first boot never attempted the digest');
    expect(first.repository.findById(child.id)).toMatchObject({
      status: 'FAILED',
      outcome: { reason: 'daemon_restart' },
    });
    first.service.onModuleDestroy();
    first.database.onModuleDestroy();

    let settlementCallbacks = 0;
    const second = openBoot(dataDir, parentId);
    const competingBoot = openBoot(dataDir, parentId);
    second.service.onTaskFinished((task) => {
      if (task.id === child.id) settlementCallbacks += 1;
    });
    competingBoot.service.onTaskFinished((task) => {
      if (task.id === child.id) settlementCallbacks += 1;
    });
    await waitFor(
      () => second.events.list(parentId).filter((event) => event.type === 'task_completed').length === 1
        && settlementCallbacks === 1,
      'competing boots did not idempotently drain the interrupted-task replay',
    );
    expect(second.events.list(parentId).filter((event) => event.type === 'task_completed')).toHaveLength(1);
    expect(settlementCallbacks).toBe(1);
    second.service.onModuleDestroy();
    second.database.onModuleDestroy();
    competingBoot.service.onModuleDestroy();
    competingBoot.database.onModuleDestroy();

    const third = openBoot(dataDir, parentId);
    third.service.onTaskFinished((task) => {
      if (task.id === child.id) settlementCallbacks += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(third.events.list(parentId).filter((event) => event.type === 'task_completed')).toHaveLength(1);
    expect(settlementCallbacks).toBe(1);
    third.service.onModuleDestroy();
    third.database.onModuleDestroy();
  });

  it('survives shutdown before the first asynchronous replay drain', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nuncio-task-reconcile-death-'));
    dirs.push(dataDir);
    const parentId = 'parent-process-death';

    process.env.NUNCIO_DATA_DIR = dataDir;
    const seedDb = new DatabaseService();
    seedParent(seedDb, parentId);
    const seedTasks = new TasksRepository(seedDb);
    const child = seedTasks.create({
      prompt: 'dies before drain',
      role: 'subagent',
      parentSessionId: parentId,
    });
    seedTasks.claimNextQueued();
    seedDb.onModuleDestroy();

    const interruptedBoot = openBoot(dataDir, parentId);
    interruptedBoot.service.onModuleDestroy();
    interruptedBoot.database.onModuleDestroy();
    await new Promise((resolve) => setTimeout(resolve, 0));

    let callbacks = 0;
    const recovered = openBoot(dataDir, parentId);
    recovered.service.onTaskFinished((task) => {
      if (task.id === child.id) callbacks += 1;
    });
    await waitFor(
      () => recovered.events.list(parentId).filter((event) => event.type === 'task_completed').length === 1
        && callbacks === 1,
      'reopened boot did not replay the durable marker',
    );
    expect(recovered.events.list(parentId).filter((event) => event.type === 'task_completed')).toHaveLength(1);
    expect(callbacks).toBe(1);
    recovered.service.onModuleDestroy();
    recovered.database.onModuleDestroy();
  });

  it('clears replay work for an interrupted standalone task without inventing a digest', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nuncio-task-reconcile-standalone-'));
    dirs.push(dataDir);
    const absentParentId = 'missing-parent';

    process.env.NUNCIO_DATA_DIR = dataDir;
    const seedDb = new DatabaseService();
    const seedTasks = new TasksRepository(seedDb);
    const task = seedTasks.create({ prompt: 'standalone interruption' });
    seedTasks.claimNextQueued();
    seedDb.onModuleDestroy();

    let callbacks = 0;
    const boot = openBoot(dataDir, absentParentId);
    boot.service.onTaskFinished((settled) => {
      if (settled.id === task.id) callbacks += 1;
    });
    await waitFor(() => callbacks === 1, 'standalone settlement callback was not replayed');
    const pending = boot.database.db.prepare<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM task_reconciliation_outbox',
    ).get();
    expect(pending?.count).toBe(0);
    expect(boot.database.db.prepare<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM events WHERE type = 'task_completed'",
    ).get()?.count).toBe(0);
    boot.service.onModuleDestroy();
    boot.database.onModuleDestroy();
  });
});
