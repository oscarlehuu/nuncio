import { Injectable } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentRunContext, EventEmitter } from '../../../src/agents/agents.types';
import { BaseAgentProvider } from '../../../src/agents/agents.base-provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';

@Injectable()
class ThrowingProvider extends BaseAgentProvider {
  readonly id = 'throwing';
  readonly name = 'Throwing';

  constructor(sessions: SessionsRepository, events: EventsRepository) {
    super(sessions, events);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async listModels(): Promise<[]> {
    return [];
  }

  protected async executePrompt(
    _sessionId: string,
    _text: string,
    _isSteer: boolean,
    _context: AgentRunContext,
  ): Promise<void> {
    throw new Error('boom');
  }
}

describe('BaseAgentProvider error path', () => {
  let module: TestingModule;
  let provider: ThrowingProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-base-err-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
    }).compile();

    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
    // Construct directly so the in-test subclass gets its base deps without
    // relying on Nest reflect-metadata for a class declared in the spec file.
    provider = new ThrowingProvider(sessions, events);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('routes an executePrompt failure to ERROR status + error event', async () => {
    const created = sessions.create({ prompt: 'fail me', provider: 'mock' });
    const emitted: { type: string; payload: unknown }[] = [];
    const emit: EventEmitter = (event) => emitted.push(event);

    await provider.run(created.id, created.prompt, { emit });

    const all = events.list(created.id);
    expect(all.some((e) => e.type === 'user_message')).toBe(true);
    expect(all.some((e) => e.type === 'error')).toBe(true);
    expect(all.some((e) => e.type === 'status' && (e.payload as { status: string }).status === 'ERROR')).toBe(true);
    expect(sessions.findById(created.id)?.status).toBe('ERROR');
    expect(emitted.some((e) => e.type === 'error')).toBe(true);
    const errorEvent = all.find((e) => e.type === 'error');
    expect((errorEvent?.payload as { message: string }).message).toBe('boom');
  });

  it('still emits RUNNING + user_message before the failure', async () => {
    const created = sessions.create({ prompt: 'fail again', provider: 'mock' });
    const emitted: { type: string; payload: unknown }[] = [];
    await provider.run(created.id, created.prompt, { emit: (e) => emitted.push(e) });

    expect(
      emitted.some((e) => e.type === 'status' && (e.payload as { status: string }).status === 'RUNNING'),
    ).toBe(true);
    expect(emitted.some((e) => e.type === 'user_message')).toBe(true);
  });
});
