import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRegistry } from '../../../src/agents/agents.registry';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsService } from '../../../src/sessions/sessions.service';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

describe('SessionsService.appendOrchestrationEvent flush ordering', () => {
  let module: TestingModule;
  let service: SessionsService;
  let repo: SessionsRepository;
  let registry: AgentRegistry;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-orch-append-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();
    module = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule, GitModule, CursorLocalModule],
        providers: [SessionsService],
      }),
    ).compile();
    service = module.get(SessionsService);
    repo = module.get(SessionsRepository);
    registry = module.get(AgentRegistry);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  it('flushes the provider buffer for a RUNNING session before appending', () => {
    const session = repo.create({ prompt: 'running parent', provider: 'cursor' });
    repo.updateStatus(session.id, 'RUNNING');
    const provider = registry.resolveForSession(repo.findById(session.id)!);
    const flush = jest.spyOn(provider, 'flushPendingEvents');

    service.appendOrchestrationEvent(session.id, 'task_completed', {
      taskId: 't1',
      status: 'DONE',
      childSessionId: null,
      outcomeSummary: null,
      verify: null,
      workspace: null,
      childBranch: null,
    });

    expect(flush).toHaveBeenCalledWith(session.id);
    flush.mockRestore();
  });

  it('does not flush for a non-RUNNING (IDLE) session', () => {
    const session = repo.create({ prompt: 'idle parent', provider: 'cursor' });
    repo.updateStatus(session.id, 'RUNNING');
    repo.updateStatus(session.id, 'IDLE');
    const provider = registry.resolveForSession(repo.findById(session.id)!);
    const flush = jest.spyOn(provider, 'flushPendingEvents');

    service.appendOrchestrationEvent(session.id, 'task_completed', {
      taskId: 't2',
      status: 'DONE',
      childSessionId: null,
      outcomeSummary: null,
      verify: null,
      workspace: null,
      childBranch: null,
    });

    expect(flush).not.toHaveBeenCalled();
    flush.mockRestore();
  });

  it('returns null and never throws when the session is gone', () => {
    expect(service.appendOrchestrationEvent('no-such', 'task_completed', {})).toBeNull();
  });
});
