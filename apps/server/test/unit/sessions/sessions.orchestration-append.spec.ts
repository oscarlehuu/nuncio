import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRegistry } from '../../../src/agents/agents.registry';
import { RetainedEventFlushError } from '../../../src/agents/agents.base-provider';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsService } from '../../../src/sessions/sessions.service';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

describe('SessionsService.appendOrchestrationEvent flush ordering', () => {
  let module: TestingModule;
  let service: SessionsService;
  let repo: SessionsRepository;
  let events: EventsRepository;
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
    events = module.get(EventsRepository);
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

  it('delays orchestration events until a retained parent delta commits', async () => {
    const session = repo.create({ prompt: 'retry ordered parent', provider: 'cursor' });
    repo.updateStatus(session.id, 'RUNNING');
    const provider = registry.resolveForSession(repo.findById(session.id)!);
    let flushAttempts = 0;
    const flush = jest.spyOn(provider, 'flushPendingEvents').mockImplementation(() => {
      flushAttempts += 1;
      if (flushAttempts === 1) {
        throw new RetainedEventFlushError(new Error('temporary sqlite failure'));
      }
      if (!events.list(session.id).some((event) => event.type === 'assistant_delta')) {
        events.append(session.id, 'assistant_delta', { delta: 'accepted before digest' });
      }
    });

    try {
      const immediate = service.appendOrchestrationEvent(session.id, 'task_completed', {
        taskId: 'retry-t1',
        status: 'DONE',
      });

      expect(immediate).toBeNull();
      expect(events.list(session.id).some((event) => event.type === 'task_completed')).toBe(false);

      const started = Date.now();
      while (
        !events.list(session.id).some((event) => event.type === 'task_completed') &&
        Date.now() - started < 1_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const ordered = events
        .list(session.id)
        .filter((event) => event.type === 'assistant_delta' || event.type === 'task_completed');
      expect(ordered.map((event) => event.type)).toEqual(['assistant_delta', 'task_completed']);
    } finally {
      flush.mockRestore();
    }
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

  it('persistOrchestrationEvent does NOT flush — the flush is a separate caller step', () => {
    const session = repo.create({ prompt: 'persist-only parent', provider: 'cursor' });
    repo.updateStatus(session.id, 'RUNNING');
    const provider = registry.resolveForSession(repo.findById(session.id)!);
    const flush = jest.spyOn(provider, 'flushPendingEvents');

    const event = service.persistOrchestrationEvent(session.id, 'task_completed', {
      taskId: 't3',
      status: 'DONE',
      childSessionId: null,
      outcomeSummary: null,
      verify: null,
      workspace: null,
      childBranch: null,
    });

    // Persist must be transaction-safe: no implicit flush (which would append+emit
    // a delta that a later rollback could not undo on the client).
    expect(flush).not.toHaveBeenCalled();
    expect(event).not.toBeNull();
    flush.mockRestore();
  });

  it('flushParentBuffer flushes a RUNNING parent and no-ops otherwise', () => {
    const running = repo.create({ prompt: 'flush running', provider: 'cursor' });
    repo.updateStatus(running.id, 'RUNNING');
    const runningProvider = registry.resolveForSession(repo.findById(running.id)!);
    const runFlush = jest.spyOn(runningProvider, 'flushPendingEvents');
    service.flushParentBuffer(running.id);
    expect(runFlush).toHaveBeenCalledWith(running.id);
    runFlush.mockRestore();

    const idle = repo.create({ prompt: 'flush idle', provider: 'cursor' });
    const idleProvider = registry.resolveForSession(repo.findById(idle.id)!);
    const idleFlush = jest.spyOn(idleProvider, 'flushPendingEvents');
    service.flushParentBuffer(idle.id); // CREATED, not RUNNING
    expect(idleFlush).not.toHaveBeenCalled();
    idleFlush.mockRestore();

    // Missing session: no throw.
    expect(() => service.flushParentBuffer('no-such')).not.toThrow();
  });

  it('returns null and never throws when the session is gone', () => {
    expect(service.appendOrchestrationEvent('no-such', 'task_completed', {})).toBeNull();
  });
});
