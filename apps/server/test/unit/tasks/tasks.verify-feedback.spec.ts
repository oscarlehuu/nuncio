import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorAgentProvider } from '../../../src/agents/providers/cursor-agent.provider';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { ControllableAgentProvider } from '../../helpers/controllable-agent.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import { TasksRepository } from '../../../src/tasks/tasks.repository';
import { TasksService } from '../../../src/tasks/tasks.service';
import type { TaskDto, TaskStatus } from '../../../src/tasks/tasks.types';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

/**
 * A queued task's outcome must wait for the WHOLE verify-feedback loop to settle,
 * not just the first run. Today `TasksService.execute` awaits `awaitRun` once and
 * records the first verify_result — so a task would finish on the first red verify
 * before the auto-fix loop runs. RED until task settlement waits for the loop.
 */

const AUTO_STEER = 'NUNCIO_VERIFY_AUTO_STEER';
const MAX_ROUNDS = 'NUNCIO_VERIFY_MAX_ROUNDS';

describe('TasksService — verify-feedback settlement', () => {
  let module: TestingModule;
  let service: TasksService;
  let repo: TasksRepository;
  let events: EventsRepository;
  let dataDir: string;
  let workspace: string;
  const prior: Record<string, string | undefined> = {};

  async function buildModule(): Promise<TestingModule> {
    return withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [
          DatabaseModule,
          SettingsModule,
          SessionsPersistenceModule,
          AgentsModule,
          GitModule,
          CursorLocalModule,
        ],
        providers: [SessionsService, TasksRepository, TasksService],
      }),
    ).compile();
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-tasks-vf-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();
    module = await buildModule();
    service = module.get(TasksService);
    repo = module.get(TasksRepository);
    events = module.get(EventsRepository);
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'nuncio-tasks-vf-ws-'));
    prior[AUTO_STEER] = process.env[AUTO_STEER];
    prior[MAX_ROUNDS] = process.env[MAX_ROUNDS];
    process.env[AUTO_STEER] = '1';
    process.env[MAX_ROUNDS] = '3';
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  function writeFlakyVerifyScript(failTimes: number): void {
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    const counterFile = join(workspace, '.nuncio', 'run-count');
    writeFileSync(
      join(workspace, '.nuncio', 'verify'),
      [
        '#!/bin/sh',
        `N=$(cat "${counterFile}" 2>/dev/null || echo 0)`,
        'N=$((N + 1))',
        `echo "$N" > "${counterFile}"`,
        `[ "$N" -le ${failTimes} ] && { echo "RED $N" >&2; exit 1; }`,
        'echo GREEN',
        'exit 0',
        '',
      ].join('\n'),
    );
  }

  /** Fails every run with UNIQUE output so the futility guard never trips early. */
  function writeUniqueFailScript(): void {
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    const counterFile = join(workspace, '.nuncio', 'run-count');
    writeFileSync(
      join(workspace, '.nuncio', 'verify'),
      [
        '#!/bin/sh',
        `N=$(cat "${counterFile}" 2>/dev/null || echo 0)`,
        'N=$((N + 1))',
        `echo "$N" > "${counterFile}"`,
        'echo "RED forever #$N" >&2',
        'exit 1',
        '',
      ].join('\n'),
    );
  }

  async function waitForStatus(
    id: string,
    statuses: TaskStatus[],
    timeoutMs = 20000,
  ): Promise<TaskDto> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const task = repo.findById(id);
      if (task && statuses.includes(task.status)) return task;
      await new Promise((r) => setTimeout(r, 50));
    }
    const task = repo.findById(id);
    throw new Error(`task ${id} did not reach ${statuses.join('/')}; was ${task?.status}`);
  }

  it('a task whose verify fails then passes finishes DONE with the GREEN verify, not the first red', async () => {
    writeFlakyVerifyScript(1); // fails once, auto-fix loop makes it pass
    const task = service.enqueue({ prompt: 'self-fixing task', provider: 'cursor', workspace });

    const finished = await waitForStatus(task.id, ['DONE', 'FAILED']);
    expect(finished.status).toBe('DONE');
    // The recorded verify outcome must be the GREEN one, proving the task waited
    // for loop settlement rather than recording the first red result.
    expect(extractVerify(finished)?.ok).toBe(true);
  }, 30000);

  it('a task that exhausts all rounds finishes at/after the session surfaces needs-attention', async () => {
    process.env[MAX_ROUNDS] = '2';
    writeUniqueFailScript();
    const task = service.enqueue({ prompt: 'unfixable task', provider: 'cursor', workspace });

    const finished = await waitForStatus(task.id, ['DONE', 'FAILED']);
    expect(finished.sessionId).toBeTruthy();
    // The linked session actually surfaced needs-attention...
    const needs = events
      .list(finished.sessionId as string)
      .find((e) => e.type === 'verify_needs_attention');
    expect(needs).toBeDefined();
    // ...and the task did not finish BEFORE that event — proving it waited for the
    // loop to settle rather than recording the first red verify (finding #6).
    expect(finished.finishedAt).toBeGreaterThanOrEqual(needs!.createdAt);
    // The recorded verify outcome is a failing one (the loop gave up).
    expect(extractVerify(finished)?.ok).toBe(false);
  }, 30000);
});

/**
 * Liveness: a task whose provider errors mid-run must still FINISH — the verify
 * settlement (awaitVerifySettled) must resolve on every terminal path, including a
 * session that ends in ERROR, or the task hangs forever (finding #1).
 */
describe('TasksService — verify-feedback settlement liveness', () => {
  let module: TestingModule;
  let service: TasksService;
  let repo: TasksRepository;
  let provider: ControllableAgentProvider;
  let dataDir: string;
  let workspace: string;
  const prior: Record<string, string | undefined> = {};

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-tasks-vf-live-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();
    module = await Test.createTestingModule({
      imports: [
        DatabaseModule,
        SettingsModule,
        SessionsPersistenceModule,
        AgentsModule,
        GitModule,
        CursorLocalModule,
      ],
      providers: [SessionsService, TasksRepository, TasksService],
    })
      .overrideProvider(CursorAgentProvider)
      .useClass(ControllableAgentProvider)
      .compile();
    service = module.get(TasksService);
    repo = module.get(TasksRepository);
    provider = module.get(CursorAgentProvider) as unknown as ControllableAgentProvider;
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'nuncio-tasks-vf-live-ws-'));
    prior[AUTO_STEER] = process.env[AUTO_STEER];
    process.env[AUTO_STEER] = '1';
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  it('a task whose provider errors mid-run still finishes and does not hang', async () => {
    // A verify command exists, so settlement is armed; the initial run() errors,
    // which drives the session to ERROR. awaitVerifySettled must still resolve.
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    writeFileSync(join(workspace, '.nuncio', 'verify'), 'echo RED >&2\nexit 1\n');
    provider.failNext(1); // the initial run() rejects → session ERROR

    const task = service.enqueue({ prompt: 'provider errors', provider: 'cursor', workspace });

    const start = Date.now();
    let finished: TaskDto | undefined;
    while (Date.now() - start < 12000) {
      const t = repo.findById(task.id);
      if (t && (t.status === 'DONE' || t.status === 'FAILED')) {
        finished = t;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(finished).toBeDefined();
    // A run that errored settles the session on ERROR → task FAILED, not hung.
    expect(finished!.status).toBe('FAILED');
  }, 20000);
});

/** The verify outcome is stored in the task's outcome object under `verify`. */
function extractVerify(task: TaskDto): { ok?: boolean } | undefined {
  const verify = (task.outcome as { verify?: { ok?: boolean } } | null)?.verify;
  return verify;
}
