import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockAgentProvider } from '../../../src/agents/providers/mock-agent.provider';
import type { EventEmitter } from '../../../src/agents/agents.types';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';

describe('MockAgentProvider', () => {
  let module: TestingModule;
  let provider: MockAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-mock-provider-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
      providers: [MockAgentProvider],
    }).compile();

    provider = module.get(MockAgentProvider);
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('is always available', async () => {
    expect(await provider.isAvailable()).toBe(true);
  });

  it('lists a single mock model entry', async () => {
    const models = await provider.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('mock');
  });

  it('runs a prompt, streams events, and reaches IDLE', async () => {
    const created = sessions.create({ prompt: 'do the thing', provider: 'mock' });
    const emitted: { type: string; payload: unknown }[] = [];
    const emit: EventEmitter = (event) => emitted.push(event);

    await provider.run(created.id, created.prompt, { emit });

    const all = events.list(created.id);
    expect(all.some((e) => e.type === 'user_message')).toBe(true);
    expect(all.some((e) => e.type === 'assistant_delta')).toBe(true);
    expect(all.some((e) => e.type === 'assistant_message')).toBe(true);
    expect(
      emitted.some((e) => e.type === 'status' && (e.payload as { status: string }).status === 'RUNNING'),
    ).toBe(true);
    expect(
      emitted.some((e) => e.type === 'status' && (e.payload as { status: string }).status === 'IDLE'),
    ).toBe(true);
    expect(sessions.findById(created.id)?.status).toBe('IDLE');
  });

  it('steers an IDLE session with a steer_message event', async () => {
    const created = sessions.create({ prompt: 'first task', provider: 'mock' });
    await provider.run(created.id, created.prompt, { emit: () => {} });
    expect(sessions.findById(created.id)?.status).toBe('IDLE');

    await provider.steer(created.id, 'change direction', { emit: () => {} });

    const all = events.list(created.id);
    expect(all.some((e) => e.type === 'steer_message')).toBe(true);
    expect(sessions.findById(created.id)?.status).toBe('IDLE');
  });
});
