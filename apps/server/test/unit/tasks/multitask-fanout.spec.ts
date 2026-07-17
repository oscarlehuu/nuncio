import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { EvidenceCaptureService } from '../../../src/evidence/evidence-capture.service';
import { GitModule } from '../../../src/git/git.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import { SettingsModule } from '../../../src/settings/settings.module';
import { MultitaskCoordinatorService } from '../../../src/tasks/multitask-coordinator.service';
import { TasksRepository } from '../../../src/tasks/tasks.repository';
import { TasksService } from '../../../src/tasks/tasks.service';
import type { TaskDto } from '../../../src/tasks/tasks.types';

/**
 * Multitask child-lifecycle conformance: a multitask-mode parent on a
 * decompose-capable engine (Mock) fans out one child per subtask, the children
 * inherit the parent's model, and the parent is RUNNING while any child is
 * unsettled — reaching IDLE only after every child settles, or PAUSED when the
 * parent detaches first.
 */
describe('Multitask decompose → fan-out', () => {
  const captureKnown = jest.fn(async () => null as never);
  let module: TestingModule;
  let sessions: SessionsService;
  let tasks: TasksService;
  let dataDir: string;

  async function waitFor<T>(
    read: () => T,
    ok: (value: T) => boolean,
    { timeout = 15000, label = 'condition' }: { timeout?: number; label?: string } = {},
  ): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = read();
      if (ok(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  const childTasks = (parentId: string): TaskDto[] => tasks.list(parentId);

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-multitask-fanout-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    process.env.NUNCIO_FORCE_MOCK = '1';

    module = await Test.createTestingModule({
      imports: [
        DatabaseModule,
        SessionsPersistenceModule,
        AgentsModule,
        GitModule,
        CursorLocalModule,
        SettingsModule,
      ],
      providers: [
        SessionsService,
        TasksRepository,
        TasksService,
        MultitaskCoordinatorService,
        { provide: EvidenceCaptureService, useValue: { captureKnown } },
      ],
    }).compile();

    sessions = module.get(SessionsService);
    tasks = module.get(TasksService);
    // Force construction so the coordinator registers itself into SessionsService.
    module.get(MultitaskCoordinatorService);
  });

  afterEach(() => {
    module.get(DatabaseService).db.exec("DELETE FROM tasks WHERE status = 'QUEUED'");
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.NUNCIO_FORCE_MOCK;
  });

  it('decomposes into 2 children that inherit the parent model, and settles the parent only after both do', async () => {
    const parent = await sessions.create({
      prompt: 'ship the whole thing',
      provider: 'mock',
      model: 'mock:default',
      mode: 'multitask',
    });

    // The coordinating turn runs synchronously up to its first await, so the
    // parent is already RUNNING when create() returns.
    expect(sessions.get(parent.id)?.status).toBe('RUNNING');

    const children = await waitFor(
      () => childTasks(parent.id),
      (list) => list.length === 2,
      { label: 'two spawned children' },
    );

    // Child model INHERITS the parent's — no silent swap.
    for (const child of children) {
      expect(child.provider).toBe('mock');
      expect(child.model).toBe('mock:default');
      expect(child.role).toBe('subagent');
      expect(child.parentSessionId).toBe(parent.id);
    }

    // Held children are non-terminal → the parent stays RUNNING (not settled).
    expect(sessions.get(parent.id)?.status).toBe('RUNNING');

    // Launch both immediately, skipping the grace window, so they run and settle.
    for (const child of children) tasks.startNow(child.id);

    await waitFor(
      () => childTasks(parent.id),
      (list) => list.every((task) => task.status === 'DONE'),
      { label: 'both children DONE' },
    );

    // Only after the children settle does the parent leave RUNNING for IDLE.
    await waitFor(
      () => sessions.get(parent.id)?.status,
      (status) => status === 'IDLE',
      { label: 'parent IDLE after children settle' },
    );
  }, 30000);

  it('does not force the parent IDLE when it detaches before children settle', async () => {
    const parent = await sessions.create({
      prompt: 'a long parallel job',
      provider: 'mock',
      model: 'mock:default',
      mode: 'multitask',
    });

    await waitFor(
      () => childTasks(parent.id),
      (list) => list.length === 2,
      { label: 'two spawned children' },
    );

    // Detach the parent while its children are still held (unsettled).
    sessions.pause(parent.id);

    // The coordinating run unwinds without dragging the parent back to IDLE.
    await sessions.awaitRun(parent.id);
    expect(sessions.get(parent.id)?.status).toBe('PAUSED');
  }, 30000);
});
