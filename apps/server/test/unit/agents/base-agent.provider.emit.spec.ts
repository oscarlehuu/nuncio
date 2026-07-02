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
class StreamingProvider extends BaseAgentProvider {
  readonly id = 'streaming';
  readonly name = 'Streaming';

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
    sessionId: string,
    _text: string,
    _isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void> {
    this.pushEvent(sessionId, 'assistant_delta', { delta: 'hel' }, context.emit);
    this.pushEvent(sessionId, 'assistant_delta', { delta: 'lo' }, context.emit);
    this.pushEvent(sessionId, 'assistant_message', { text: 'hello' }, context.emit);
  }
}

describe('BaseAgentProvider emit contract', () => {
  let module: TestingModule;
  let provider: StreamingProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-emit-seq-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
    }).compile();

    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
    provider = new StreamingProvider(sessions, events);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('emits the appended event with its persisted seq and createdAt', async () => {
    const created = sessions.create({ prompt: 'stream me', provider: 'streaming' });
    const emitted: Parameters<NonNullable<EventEmitter>>[0][] = [];

    await provider.run(created.id, created.prompt, { emit: (event) => emitted.push(event) });

    const persisted = events.list(created.id);
    // Every emitted event must be the persisted row itself: same seq, type,
    // payload and createdAt — subscribers must not need to re-read the log.
    expect(emitted.length).toBe(persisted.length);
    for (let i = 0; i < emitted.length; i++) {
      expect(emitted[i].seq).toBe(persisted[i].seq);
      expect(emitted[i].type).toBe(persisted[i].type);
      expect(emitted[i].createdAt).toBe(persisted[i].createdAt);
      expect(emitted[i].payload).toEqual(persisted[i].payload);
    }
  });

  it('emits strictly increasing seq for consecutive deltas', async () => {
    const created = sessions.create({ prompt: 'stream again', provider: 'streaming' });
    const emitted: Parameters<NonNullable<EventEmitter>>[0][] = [];

    await provider.run(created.id, created.prompt, { emit: (event) => emitted.push(event) });

    const seqs = emitted.map((event) => event.seq ?? 0);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });
});
