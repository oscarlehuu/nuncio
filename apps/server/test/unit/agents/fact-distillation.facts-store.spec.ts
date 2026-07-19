import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FactDistillationService } from '../../../src/agents/fact-distillation.service';
import { ContextModule } from '../../../src/context/context.module';
import { ContextFactsService } from '../../../src/context/context-facts.service';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';

/**
 * Level-3 wiring: distillation output flows through the REAL ContextFactsService
 * + SQLite repos, so the B3 precedence rules (agent writes land, founder facts
 * become proposals) are exercised end-to-end rather than faked.
 */
describe('FactDistillationService against the real facts store', () => {
  let module: TestingModule;
  let service: FactDistillationService;
  let facts: ContextFactsService;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;
  let sessionId: string;
  let completionText: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-distill-store-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, ContextModule],
    }).compile();
    facts = module.get(ContextFactsService);
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);

    const provider = {
      id: 'pi',
      completeOneShot: async () => completionText,
    };
    service = new FactDistillationService(
      sessions,
      events,
      facts,
      { available: async () => [provider] } as never,
      { resolve: () => undefined } as never,
    );
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  beforeEach(() => {
    const session = sessions.create({ prompt: 'p', provider: 'cursor', projectPath: '/repo/x' });
    sessionId = session.id;
    for (let i = 0; i < 4; i++) events.append(sessionId, 'tool_start', { tool: 'bash' });
    events.append(sessionId, 'assistant_message', { text: 'done' });
  });

  it('writes a new key directly with agent provenance and the source session', async () => {
    completionText = '[{"key":"verify-command","value":"run bun test from apps/server"}]';
    await service.handleEvent(sessionId, { seq: 99, type: 'status', payload: { status: 'IDLE' }, createdAt: 1 });

    const stored = facts.list('/repo/x').find((f) => f.key === 'verify-command');
    expect(stored).toMatchObject({
      value: 'run bun test from apps/server',
      provenance: 'agent',
      sourceSessionId: sessionId,
    });
  });

  it('a founder-owned key becomes a pending proposal, never an overwrite', async () => {
    facts.upsert({ projectPath: '/repo/x', key: 'deploy-branch', value: 'main only', provenance: 'founder' });
    completionText = '[{"key":"deploy-branch","value":"push anywhere"}]';

    await service.handleEvent(sessionId, { seq: 99, type: 'status', payload: { status: 'IDLE' }, createdAt: 1 });

    expect(facts.list('/repo/x').find((f) => f.key === 'deploy-branch')?.value).toBe('main only');
    const proposals = facts.listProposals('/repo/x');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ key: 'deploy-branch', proposedValue: 'push anywhere', status: 'pending' });
  });
});
