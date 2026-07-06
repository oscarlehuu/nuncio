import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { SettingsModule } from '../../../src/settings/settings.module';
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

  function writeAlwaysFailScript(): void {
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    writeFileSync(join(workspace, '.nuncio', 'verify'), 'echo "RED forever" >&2\nexit 1\n');
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

  it('a task that exhausts all rounds finishes recording the needs-attention outcome', async () => {
    process.env[MAX_ROUNDS] = '2';
    writeAlwaysFailScript();
    const task = service.enqueue({ prompt: 'unfixable task', provider: 'cursor', workspace });

    const finished = await waitForStatus(task.id, ['DONE', 'FAILED']);
    // However the terminal status is mapped, the outcome must reflect that the
    // loop surfaced needs-attention (exhausted rounds) — not a bare first red.
    const verify = extractVerify(finished);
    expect(verify?.ok).toBe(false);
    const outcomeStr = JSON.stringify(finished);
    expect(outcomeStr).toContain('needs_attention');
  }, 30000);
});

/** The verify outcome is stored in the task's outcome object under `verify`. */
function extractVerify(task: TaskDto): { ok?: boolean } | undefined {
  const verify = (task.outcome as { verify?: { ok?: boolean } } | null)?.verify;
  return verify;
}
