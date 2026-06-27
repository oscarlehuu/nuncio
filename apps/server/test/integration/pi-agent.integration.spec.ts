import { Test, TestingModule } from '@nestjs/testing';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgentProvider } from '../../src/agents/providers/pi-agent.provider';
import { DatabaseModule } from '../../src/db/database.module';
import { EventsRepository } from '../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../src/sessions/persistence/sessions.repository';

// Gate the suite on the same agent dir the Pi SDK resolves (PI_CODING_AGENT_DIR
// or ~/.pi/agent). Skips entirely in CI / machines without real Pi auth, so the
// Pi SDK native module is never loaded there.
const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
const hasRealPiAuth = existsSync(join(piAgentDir, 'auth.json'));
const suite = hasRealPiAuth ? describe : describe.skip;

suite('PiAgentProvider with real Pi auth (integration)', () => {
  let module: TestingModule;
  let provider: PiAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;
  let previousForceMock: string | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-integration-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    previousForceMock = process.env.NUNCIO_FORCE_MOCK;
    delete process.env.NUNCIO_FORCE_MOCK;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
      providers: [PiAgentProvider],
    }).compile();

    provider = module.get(PiAgentProvider);
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    if (previousForceMock === undefined) delete process.env.NUNCIO_FORCE_MOCK;
    else process.env.NUNCIO_FORCE_MOCK = previousForceMock;
  });

  it('reports availability when Pi auth is configured', async () => {
    expect(await provider.isAvailable()).toBe(true);
  });

  it('lists real models from the Pi registry', async () => {
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((p) => p.id === 'pi')).toBe(true);
  });

  // Real LLM call — uses the configured Pi credentials. Minimal prompt to keep
  // cost/latency low; the agent's bash/read tools are available but a "reply
  // pong" prompt should not invoke them.
  it(
    'runs a real prompt and reaches IDLE',
    async () => {
      const created = sessions.create({ prompt: 'Reply with the single word: pong', provider: 'pi' });

      await provider.run(created.id, created.prompt, { emit: () => {} });

      const all = events.list(created.id);
      expect(all.some((e) => e.type === 'user_message')).toBe(true);
      expect(all.some((e) => e.type === 'assistant_message')).toBe(true);
      expect(sessions.findById(created.id)?.status).toBe('IDLE');
    },
    60_000,
  );
});
