import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
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

describe('SessionsService restart reconciliation', () => {
  let dataDir: string;
  let module: TestingModule;
  let sessions: SessionsRepository;
  let events: EventsRepository;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-reconcile-test-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();

    module = await buildModule();
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  function seedRunning(input: {
    provider: string;
    providerThreadId?: string;
    cursorBackend?: 'sdk' | 'cli';
    cursorChatId?: string;
  }): string {
    const created = sessions.create({
      prompt: 'restart reconcile seed',
      provider: input.provider,
      ...(input.cursorBackend ? { cursorBackend: input.cursorBackend } : {}),
      ...(input.cursorChatId ? { cursorChatId: input.cursorChatId } : {}),
    });
    sessions.updateStatus(created.id, 'RUNNING');
    sessions.updateProviderRuntimeState(created.id, {
      providerActiveTurnId: 'turn-1',
      ...(input.providerThreadId ? { providerThreadId: input.providerThreadId } : {}),
    });
    events.append(created.id, 'user_message', { text: 'restart reconcile seed' });
    return created.id;
  }

  it('marks sessions stuck RUNNING as IDLE with a runtime_restarted event on boot', async () => {
    const piId = seedRunning({ provider: 'pi', providerThreadId: '/tmp/pi-session.jsonl' });
    const sdkId = seedRunning({ provider: 'cursor', cursorBackend: 'sdk' });
    const idleId = sessions.create({ prompt: 'idle bystander', provider: 'cursor' }).id;

    const restarted = await buildModule();
    restarted.get(SessionsService);

    const pi = sessions.findById(piId)!;
    expect(pi.status).toBe('IDLE');
    expect(pi.providerActiveTurnId).toBeNull();
    // The Pi session file survives reconciliation — it is the resume handle.
    expect(pi.providerThreadId).toBe('/tmp/pi-session.jsonl');

    const piEvents = events.list(piId, 0);
    const restartEvent = piEvents.find((e) => e.type === 'runtime_restarted');
    expect(restartEvent).toBeDefined();
    expect(restartEvent!.payload).toMatchObject({ resumable: true });
    const statusEvent = piEvents[piEvents.length - 1];
    expect(statusEvent).toMatchObject({ type: 'status', payload: { status: 'IDLE' } });
    // seq stays strictly increasing across the restart boundary.
    const seqs = piEvents.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    const sdk = sessions.findById(sdkId)!;
    expect(sdk.status).toBe('IDLE');
    const sdkRestart = events.list(sdkId, 0).find((e) => e.type === 'runtime_restarted');
    expect(sdkRestart!.payload).toMatchObject({ resumable: false });

    const idle = sessions.findById(idleId)!;
    expect(idle.status).toBe('CREATED');
    expect(events.list(idleId, 0).find((e) => e.type === 'runtime_restarted')).toBeUndefined();

    await restarted.close();
  });

  it('treats cursor CLI handoff sessions as resumable', async () => {
    const cliId = seedRunning({
      provider: 'cursor',
      cursorBackend: 'cli',
      cursorChatId: 'chat-123',
    });

    const restarted = await buildModule();
    restarted.get(SessionsService);

    expect(sessions.findById(cliId)!.status).toBe('IDLE');
    const restartEvent = events.list(cliId, 0).find((e) => e.type === 'runtime_restarted');
    expect(restartEvent!.payload).toMatchObject({ resumable: true });

    await restarted.close();
  });

  it('steer works on a reconciled session', async () => {
    const id = seedRunning({ provider: 'cursor', cursorBackend: 'sdk' });

    const restarted = await buildModule();
    const service = restarted.get(SessionsService);

    const after = await service.steer(id, 'continue after restart');
    expect(after.status).toBe('IDLE');
    const all = restarted.get(EventsRepository).list(id, 0);
    expect(all.find((e) => e.type === 'steer_message')).toMatchObject({
      payload: { text: 'continue after restart' },
    });

    await restarted.close();
  });
});
