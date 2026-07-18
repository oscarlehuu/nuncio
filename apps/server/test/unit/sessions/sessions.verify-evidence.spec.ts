import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { EvidenceCaptureService } from '../../../src/evidence/evidence-capture.service';
import { GitModule } from '../../../src/git/git.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import type { SessionDto } from '../../../src/sessions/domain/sessions.types';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

/**
 * Evidence auto-fallback: a GREEN verify on a turn whose dirty classes include
 * `ui` captures after-evidence (known target first, `NUNCIO_EVIDENCE_URL`
 * fallback) and appends an `evidence_captured` event. Fail-open: a capture
 * failure logs and never touches the verify loop.
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

class FakeEvidenceCaptureService {
  knownCalls: Array<{ sessionId: string; phase: string }> = [];
  captureCalls: Array<{ sessionId: string; input: unknown }> = [];
  knownOutcome: unknown = null;
  captureOutcome: unknown = { afterRef: { id: 'm1', mimeType: 'image/png' }, route: '/', viewport: { w: 1, h: 1 }, workspaceHead: 'head' };
  shouldThrow = false;

  async captureKnown(session: SessionDto, phase: string): Promise<unknown> {
    if (this.shouldThrow) throw new Error('capture exploded');
    this.knownCalls.push({ sessionId: session.id, phase });
    return this.knownOutcome;
  }

  async capture(session: SessionDto, input: unknown): Promise<unknown> {
    if (this.shouldThrow) throw new Error('capture exploded');
    this.captureCalls.push({ sessionId: session.id, input });
    return this.captureOutcome;
  }
}

describe('SessionsService verify evidence auto-fallback', () => {
  let module: TestingModule;
  let service: SessionsService;
  let events: EventsRepository;
  let evidence: FakeEvidenceCaptureService;
  let dataDir: string;
  let workspace: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-verify-evidence-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();

    evidence = new FakeEvidenceCaptureService();
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
        providers: [
          SessionsService,
          { provide: EvidenceCaptureService, useValue: evidence },
        ],
      }),
    ).compile();

    service = module.get(SessionsService);
    events = module.get(EventsRepository);
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'nuncio-verify-evidence-ws-'));
    runGit(workspace, ['init', '-q']);
    writeFileSync(join(workspace, 'base.txt'), 'base\n');
    runGit(workspace, ['add', '.']);
    runGit(workspace, ['commit', '-q', '-m', 'base']);
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    writeFileSync(join(workspace, '.nuncio', 'verify'), 'echo ok\nexit 0\n');
    evidence.knownCalls = [];
    evidence.captureCalls = [];
    evidence.knownOutcome = null;
    evidence.shouldThrow = false;
    delete process.env.NUNCIO_EVIDENCE_URL;
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
    delete process.env.NUNCIO_EVIDENCE_URL;
  });

  async function waitFor<T>(probe: () => T | undefined, timeoutMs = 8000): Promise<T | undefined> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = probe();
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return probe();
  }

  it(
    'captures after-evidence from the known target on a green ui-touching verify',
    async () => {
      writeFileSync(join(workspace, 'App.tsx'), 'export const App = () => null;\n');
      evidence.knownOutcome = {
        afterRef: { id: 'media-1', mimeType: 'image/png' },
        route: '/app',
        viewport: { w: 1440, h: 900 },
        workspaceHead: 'headsha',
      };
      const session = await service.create({ prompt: 'ui change', provider: 'cursor', workspace });
      await service.awaitRun(session.id);

      const captured = await waitFor(() =>
        events.list(session.id).find((e) => e.type === 'evidence_captured'),
      );
      expect(captured).toBeDefined();
      expect(captured!.payload).toMatchObject({ route: '/app' });
      expect(evidence.knownCalls).toEqual([{ sessionId: session.id, phase: 'after' }]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'falls back to NUNCIO_EVIDENCE_URL when no known target exists',
    async () => {
      process.env.NUNCIO_EVIDENCE_URL = 'http://localhost:5173';
      writeFileSync(join(workspace, 'App.tsx'), 'export const App = () => null;\n');
      const session = await service.create({ prompt: 'ui change', provider: 'cursor', workspace });
      await service.awaitRun(session.id);

      const captured = await waitFor(() =>
        events.list(session.id).find((e) => e.type === 'evidence_captured'),
      );
      expect(captured).toBeDefined();
      expect(evidence.captureCalls).toEqual([
        { sessionId: session.id, input: { url: 'http://localhost:5173', phase: 'after' } },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not capture on a green verify that touched no ui files',
    async () => {
      writeFileSync(join(workspace, 'service.ts'), 'export const x = 1;\n');
      const session = await service.create({ prompt: 'server change', provider: 'cursor', workspace });
      await service.awaitRun(session.id);
      await waitFor(() => events.list(session.id).find((e) => e.type === 'verify_result'));
      // Give any (wrong) capture a beat to fire.
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(evidence.knownCalls).toEqual([]);
      expect(evidence.captureCalls).toEqual([]);
      expect(events.list(session.id).some((e) => e.type === 'evidence_captured')).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stays green and settled when evidence capture throws (fail-open)',
    async () => {
      writeFileSync(join(workspace, 'App.tsx'), 'export const App = () => null;\n');
      evidence.shouldThrow = true;
      const session = await service.create({ prompt: 'ui change', provider: 'cursor', workspace });
      await service.awaitRun(session.id);

      const result = await waitFor(() =>
        events.list(session.id).find((e) => e.type === 'verify_result'),
      );
      expect(result!.payload).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(service.get(session.id)?.status).toBe('IDLE');
      expect(events.list(session.id).some((e) => e.type === 'evidence_captured')).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
