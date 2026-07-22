import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
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

describe('SessionsService combined restart + steer queue', () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-restart-queue-combined-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  it('reconciles a resumable RUNNING session and drains queued steers once on boot', async () => {
    const first = await buildModule();
    const service = first.get(SessionsService);
    const sessions = first.get(SessionsRepository);
    const events = first.get(EventsRepository);

    const id = sessions.create({ prompt: 'combined restart seed', provider: 'cursor' }).id;
    sessions.updateStatus(id, 'RUNNING');
    sessions.updateProviderRuntimeState(id, { providerActiveTurnId: 'turn-1' });
    events.append(id, 'user_message', { text: 'combined restart seed' });

    await service.steer(id, 'first queued across restart');
    await service.steer(id, 'second queued across restart');

    expect(events.list(id, 0).some((e) => e.type === 'steer_queued')).toBe(true);
    expect(steerMessages(events.list(id, 0))).toEqual([]);
    await first.close();

    const restarted = await buildModule();
    restarted.get(SessionsService);
    const restartedEvents = restarted.get(EventsRepository);
    const restartedSessions = restarted.get(SessionsRepository);

    await waitFor(() => restartedEvents.list(id, 0).some((e) => e.type === 'runtime_restarted'));
    await waitFor(() => steerMessages(restartedEvents.list(id, 0)).length === 2);
    await waitFor(() => restartedSessions.findById(id)?.status === 'IDLE');

    const session = restartedSessions.findById(id)!;
    expect(session.status).toBe('IDLE');
    expect(session.providerActiveTurnId).toBeNull();

    const all = restartedEvents.list(id, 0);
    const restartEvent = all.find((e) => e.type === 'runtime_restarted');
    expect(restartEvent).toBeDefined();
    expect(restartEvent!.payload).toMatchObject({ resumable: false });

    expect(steerMessages(all)).toEqual([
      'first queued across restart',
      'second queued across restart',
    ]);
    expect(all.filter((e) => e.type === 'steer_queued').length).toBe(2);

    const seqs = all.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    await restarted.close();

    // A second boot must not re-deliver already-drained steers.
    const third = await buildModule();
    third.get(SessionsService);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(steerMessages(third.get(EventsRepository).list(id, 0)).length).toBe(2);
    await third.close();
  });

  it('does not reconcile or drain a persisted legacy Crew member on boot', async () => {
    const first = await buildModule();
    const service = first.get(SessionsService);
    const sessions = first.get(SessionsRepository);
    const events = first.get(EventsRepository);
    const database = first.get(DatabaseService);

    const id = sessions.create({ prompt: 'retired Crew member', provider: 'cursor' }).id;
    sessions.updateStatus(id, 'RUNNING');
    sessions.updateProviderRuntimeState(id, { providerActiveTurnId: 'crew-turn' });
    await service.steer(id, 'queued before Crew removal');
    database.db.prepare("UPDATE sessions SET verify_owner = 'crew' WHERE id = ?").run(id);
    await first.close();

    const restarted = await buildModule();
    restarted.get(SessionsService);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const raw = restarted.get(SessionsRepository).findById(id)!;
    const after = restarted.get(EventsRepository).list(id, 0);
    expect(raw.status).toBe('RUNNING');
    expect(raw.providerActiveTurnId).toBe('crew-turn');
    expect(after.some((event) => event.type === 'runtime_restarted')).toBe(false);
    expect(steerMessages(after)).toEqual([]);

    await restarted.close();
  });
});
