import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

describe('SessionsService verifier gate', () => {
  let module: TestingModule;
  let service: SessionsService;
  let events: EventsRepository;
  let dataDir: string;
  let workspace: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-verify-gate-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();

    module = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule, GitModule, CursorLocalModule],
        providers: [SessionsService],
      }),
    ).compile();

    service = module.get(SessionsService);
    events = module.get(EventsRepository);
  });

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'nuncio-verify-ws-'));
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

  function writeVerifyScript(body: string): void {
    mkdirSync(join(workspace, '.nuncio'), { recursive: true });
    writeFileSync(join(workspace, '.nuncio', 'verify'), body);
  }

  async function waitForVerifyResult(sessionId: string, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = events.list(sessionId).find((e) => e.type === 'verify_result');
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  }

  it('appends verify_start and a passing verify_result after a run ends IDLE', async () => {
    writeVerifyScript('echo checks-ok\nexit 0\n');
    const session = await service.create({ prompt: 'verify me', provider: 'cursor', workspace });

    const result = await waitForVerifyResult(session.id);
    expect(result).toBeDefined();
    expect(result!.payload).toMatchObject({ ok: true, exitCode: 0, command: '.nuncio/verify' });
    expect(events.list(session.id).some((e) => e.type === 'verify_start')).toBe(true);
  });

  it('reports a failing verify without touching the session status', async () => {
    writeVerifyScript('echo nope >&2\nexit 1\n');
    const session = await service.create({ prompt: 'verify fail', provider: 'cursor', workspace });

    const result = await waitForVerifyResult(session.id);
    expect(result!.payload).toMatchObject({ ok: false, exitCode: 1 });
    expect(service.get(session.id)?.status).toBe('IDLE');
  });

  it('awaitRun resolves only after the run and its verification settle', async () => {
    writeVerifyScript('echo verified\nexit 0\n');
    const session = await service.create({ prompt: 'await me', provider: 'cursor', workspace });

    await service.awaitRun(session.id);

    // No polling: the verify outcome must already be in the log.
    const all = events.list(session.id);
    expect(all.some((e) => e.type === 'verify_result')).toBe(true);
    expect(service.get(session.id)?.status).toBe('IDLE');
  });

  it('awaitRun resolves immediately for sessions with no in-flight run', async () => {
    await expect(service.awaitRun('missing1')).resolves.toBeUndefined();
  });

  it('skips verification entirely when no command is configured', async () => {
    const session = await service.create({ prompt: 'no verify', provider: 'cursor', workspace });

    const result = await waitForVerifyResult(session.id, 1000);
    expect(result).toBeUndefined();
    expect(events.list(session.id).some((e) => e.type === 'verify_start')).toBe(false);
  });
});
