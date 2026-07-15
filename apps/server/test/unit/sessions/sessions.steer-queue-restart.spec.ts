import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { AgentRegistry } from '../../../src/agents/agents.registry';
import type { AgentProvider } from '../../../src/agents/agents.types';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

async function buildModule(): Promise<TestingModule> {
  return withSimulatedCursorProvider(
    Test.createTestingModule({
      imports: [DatabaseModule, GitModule, SessionsPersistenceModule, AgentsModule, CursorLocalModule],
      providers: [SessionsService],
    }),
  ).compile();
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('condition not met within timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function steerMessages(events: SessionEvent[]): string[] {
  return events
    .filter((e) => e.type === 'steer_message')
    .map((e) => String((e.payload as { text?: string }).text ?? ''));
}

describe('Steer queue survives server restart', () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-steer-queue-restart-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  it('delivers a steer queued while RUNNING after the server restarts', async () => {
    const first = await buildModule();
    const service = first.get(SessionsService);
    const sessions = first.get(SessionsRepository);
    const events = first.get(EventsRepository);

    const id = sessions.create({ prompt: 'restart queue seed', provider: 'cursor' }).id;
    sessions.updateStatus(id, 'RUNNING');
    await service.steer(id, 'queued across restart');

    expect(events.list(id, 0).some((e) => e.type === 'steer_queued')).toBe(true);
    expect(steerMessages(events.list(id, 0))).toEqual([]);
    await first.close();

    const restarted = await buildModule();
    restarted.get(SessionsService);
    const restartedEvents = restarted.get(EventsRepository);
    const restartedSessions = restarted.get(SessionsRepository);

    // Boot reconcile settles the interrupted run on IDLE; the restored queue
    // must then deliver the message as a real steer.
    await waitFor(() =>
      steerMessages(restartedEvents.list(id, 0)).includes('queued across restart'),
    );
    await waitFor(() => restartedSessions.findById(id)?.status === 'IDLE');

    await restarted.close();
  });

  it('reports a post-restart background delivery failure from durable context', async () => {
    const first = await buildModule();
    const firstService = first.get(SessionsService);
    const sessions = first.get(SessionsRepository);
    const id = sessions.create({ prompt: 'restart failure seed', provider: 'cursor' }).id;
    sessions.updateStatus(id, 'RUNNING');
    firstService.steerInBackground(
      id,
      'durable forge feedback',
      undefined,
      undefined,
      'forge:github:pr-feedback',
      { kind: 'pr-feedback', subjectId: 'octo/nuncio#7' },
    );
    await first.close();

    const restarted = await buildModule();
    const restartedService = restarted.get(SessionsService);
    const registry = restarted.get(AgentRegistry);
    const failingProvider: AgentProvider = {
      id: 'failing',
      name: 'Failing',
      capabilities: {
        interrupt: false,
        modelSwitch: 'none',
        effortSwitch: 'none',
        images: false,
        steerWhileRunning: false,
      },
      isAvailable: async () => true,
      listModels: async () => [],
      run: async () => undefined,
      steer: async () => { throw new Error('provider unavailable after restart'); },
      quiesce: async () => undefined,
      dispose: () => undefined,
      bustCache: () => undefined,
    };
    registry.resolveForSession = (() => failingProvider) as AgentRegistry['resolveForSession'];
    registry.resolveAvailableForSession = (async () =>
      failingProvider) as AgentRegistry['resolveAvailableForSession'];
    const failures: Array<{ context: Record<string, unknown>; error: unknown }> = [];
    restartedService.onBackgroundSteerFailure((failure) => failures.push(failure));

    await waitFor(() => failures.length > 0);
    expect(failures[0]?.context).toEqual({
      kind: 'pr-feedback',
      subjectId: 'octo/nuncio#7',
    });
    expect(failures[0]?.error).toBeInstanceOf(Error);
    await restarted.close();
  });

  it('delivers a steer left queued on an IDLE session (crash mid-drain) without duplicating it', async () => {
    const first = await buildModule();
    const service = first.get(SessionsService);
    const sessions = first.get(SessionsRepository);

    const id = sessions.create({ prompt: 'idle queue seed', provider: 'cursor' }).id;
    sessions.updateStatus(id, 'RUNNING');
    await service.steer(id, 'stranded while idle');
    // The daemon died right after the run settled but before the drain ran:
    // the session row reads IDLE while the queued steer is still pending.
    sessions.updateStatus(id, 'IDLE');
    await first.close();

    const restarted = await buildModule();
    restarted.get(SessionsService);
    const restartedEvents = restarted.get(EventsRepository);

    await waitFor(() =>
      steerMessages(restartedEvents.list(id, 0)).includes('stranded while idle'),
    );
    await waitFor(
      () => restarted.get(SessionsRepository).findById(id)?.status === 'IDLE',
    );
    const deliveredCount = steerMessages(restartedEvents.list(id, 0)).length;
    await restarted.close();

    // A further restart must not re-deliver an already-drained steer.
    const third = await buildModule();
    third.get(SessionsService);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(steerMessages(third.get(EventsRepository).list(id, 0)).length).toBe(deliveredCount);
    await third.close();
  });

  it('delivers multiple queued steers in FIFO order after a restart', async () => {
    const first = await buildModule();
    const service = first.get(SessionsService);
    const sessions = first.get(SessionsRepository);

    const id = sessions.create({ prompt: 'fifo queue seed', provider: 'cursor' }).id;
    sessions.updateStatus(id, 'RUNNING');
    await service.steer(id, 'first queued');
    await service.steer(id, 'second queued');
    await first.close();

    const restarted = await buildModule();
    restarted.get(SessionsService);
    const restartedEvents = restarted.get(EventsRepository);

    await waitFor(() => steerMessages(restartedEvents.list(id, 0)).length === 2);
    expect(steerMessages(restartedEvents.list(id, 0))).toEqual([
      'first queued',
      'second queued',
    ]);

    await restarted.close();
  });
});
