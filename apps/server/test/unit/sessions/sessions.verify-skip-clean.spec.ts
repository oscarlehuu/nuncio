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
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

/**
 * Skip-on-clean: the post-turn verifier consults the shared turn-diff
 * classifier and skips entirely (no verify_* events) when the workspace
 * fingerprint has not moved since the last GREEN verify. A red pin never
 * skips (the feedback loop's semantics stay intact), and a non-git workspace
 * always verifies (no fingerprint to trust).
 */

const TEST_TIMEOUT_MS = 20000;

function runGit(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`);
  }
}

describe('SessionsService verify skip-on-clean', () => {
  let module: TestingModule;
  let service: SessionsService;
  let events: EventsRepository;
  let dataDir: string;
  let workspace: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-verify-skip-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();

    module = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [
          DatabaseModule,
          SettingsModule,
          SessionsPersistenceModule,
          AgentsModule,
          GitModule,
          CursorLocalModule,
        ],
        providers: [SessionsService],
      }),
    ).compile();

    service = module.get(SessionsService);
    events = module.get(EventsRepository);
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'nuncio-verify-skip-ws-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  function initGitWorkspace(): void {
    runGit(workspace, ['init', '-q']);
    writeFileSync(join(workspace, 'base.txt'), 'base\n');
    runGit(workspace, ['add', '.']);
    runGit(workspace, ['commit', '-q', '-m', 'base']);
  }

  function writeVerifyScript(body: string): void {
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    writeFileSync(join(workspace, '.nuncio', 'verify'), body);
  }

  function ofType(sessionId: string, type: string): SessionEvent[] {
    return events.list(sessionId).filter((e) => e.type === type);
  }

  async function waitForCount(
    sessionId: string,
    type: string,
    count: number,
    timeoutMs = 8000,
  ): Promise<SessionEvent[]> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = ofType(sessionId, type);
      if (found.length >= count) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return ofType(sessionId, type);
  }

  /** Steer and wait for the whole turn + verify chain to unwind. */
  async function steerAndSettle(sessionId: string, message: string): Promise<void> {
    await service.continueExistingSession(sessionId, { prompt: message });
  }

  it(
    'skips the second verify when nothing changed since the green pin',
    async () => {
      initGitWorkspace();
      writeVerifyScript('echo ok\nexit 0\n');
      const session = await service.create({ prompt: 'first', provider: 'cursor', workspace });
      await service.awaitRun(session.id);
      const first = await waitForCount(session.id, 'verify_result', 1);
      expect(first).toHaveLength(1);
      expect(first[0]!.payload).toMatchObject({ ok: true });

      // Q&A turn: the simulated provider changes no files.
      await steerAndSettle(session.id, 'just a question');

      expect(ofType(session.id, 'verify_start')).toHaveLength(1);
      expect(ofType(session.id, 'verify_result')).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    're-verifies when the workspace changed after the green pin',
    async () => {
      initGitWorkspace();
      writeVerifyScript('echo ok\nexit 0\n');
      const session = await service.create({ prompt: 'first', provider: 'cursor', workspace });
      await service.awaitRun(session.id);
      await waitForCount(session.id, 'verify_result', 1);

      writeFileSync(join(workspace, 'changed.ts'), 'export const x = 1;\n');
      await steerAndSettle(session.id, 'now I changed a file');

      const results = await waitForCount(session.id, 'verify_result', 2);
      expect(results).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'never skips after a red verify even when nothing changed',
    async () => {
      initGitWorkspace();
      writeVerifyScript('echo bad >&2\nexit 1\n');
      const session = await service.create({ prompt: 'first', provider: 'cursor', workspace });
      await service.awaitRun(session.id);
      const first = await waitForCount(session.id, 'verify_result', 1);
      expect(first[0]!.payload).toMatchObject({ ok: false });

      await steerAndSettle(session.id, 'no changes, still red');

      const results = await waitForCount(session.id, 'verify_result', 2);
      expect(results).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'always verifies in a non-git workspace',
    async () => {
      writeVerifyScript('echo ok\nexit 0\n');
      const session = await service.create({ prompt: 'first', provider: 'cursor', workspace });
      await service.awaitRun(session.id);
      await waitForCount(session.id, 'verify_result', 1);

      await steerAndSettle(session.id, 'plain dir turn');

      const results = await waitForCount(session.id, 'verify_result', 2);
      expect(results).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'annotates verify_start with the dirty files/classes and verify_result with the fingerprint',
    async () => {
      initGitWorkspace();
      writeFileSync(join(workspace, 'App.tsx'), 'export const App = () => null;\n');
      writeVerifyScript('echo ok\nexit 0\n');
      const session = await service.create({ prompt: 'annotate', provider: 'cursor', workspace });
      await service.awaitRun(session.id);
      const [start] = await waitForCount(session.id, 'verify_start', 1);
      const [result] = await waitForCount(session.id, 'verify_result', 1);

      const startPayload = start!.payload as {
        files?: string[];
        filesTotal?: number;
        classes?: string[];
      };
      expect(startPayload.files).toContain('App.tsx');
      expect(startPayload.classes).toContain('ui');
      expect(typeof startPayload.filesTotal).toBe('number');
      const resultPayload = result!.payload as { fingerprint?: string; classes?: string[] };
      expect(typeof resultPayload.fingerprint).toBe('string');
      expect(resultPayload.classes).toContain('ui');
    },
    TEST_TIMEOUT_MS,
  );
});
