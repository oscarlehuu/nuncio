import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CursorLocalModule } from '../../../src/cursor-local/cursor-local.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { GitModule } from '../../../src/git/git.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsService } from '../../../src/sessions/sessions.service';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

describe('SessionsService subscribe / event bus', () => {
  let module: TestingModule;
  let service: SessionsService;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-subscribe-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();

    module = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [DatabaseModule, SessionsPersistenceModule, AgentsModule, GitModule, CursorLocalModule],
        providers: [SessionsService],
      }),
    ).compile();

    service = module.get(SessionsService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  it('delivers emitted events to a subscriber', async () => {
    const session = await service.create({ prompt: 'sub me', provider: 'cursor' });
    await waitForIdle(service, session.id);

    const received: string[] = [];
    service.subscribe(session.id, (event) => received.push(event.type));

    service.pause(session.id); // IDLE -> PAUSED emits a status event

    expect(received).toContain('status');
  });

  it('stops delivering after unsubscribe', async () => {
    const session = await service.create({ prompt: 'unsub me', provider: 'cursor' });
    await waitForIdle(service, session.id);

    const received: string[] = [];
    const unsubscribe = service.subscribe(session.id, (event) => received.push(event.type));

    service.pause(session.id);
    const countAfterPause = received.length;
    unsubscribe();

    service.archive(session.id); // emits another status event

    expect(received.length).toBe(countAfterPause);
  });
});

async function waitForIdle(service: SessionsService, id: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = service.get(id);
    if (session?.status === 'IDLE' || session?.status === 'ERROR') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Session ${id} did not reach IDLE in time`);
}
