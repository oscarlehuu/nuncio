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

  it('defaults capabilities to all-off for non-overriding providers', () => {
    expect(provider.capabilities).toEqual({
      interrupt: false,
      modelSwitch: 'none',
      effortSwitch: 'none',
      images: false,
    });
  });

  it('routes an executePrompt failure to ERROR status + error event', async () => {
    const created = sessions.create({ prompt: 'fail me', provider: 'throwing' });
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
    const created = sessions.create({ prompt: 'fail again', provider: 'throwing' });
    const emitted: { type: string; payload: unknown }[] = [];
    await provider.run(created.id, created.prompt, { emit: (e) => emitted.push(e) });

    expect(
      emitted.some((e) => e.type === 'status' && (e.payload as { status: string }).status === 'RUNNING'),
    ).toBe(true);
    expect(emitted.some((e) => e.type === 'user_message')).toBe(true);
  });

  describe('race with delete', () => {
    it('does not throw when the session is deleted while executePrompt is in flight', async () => {
      // Provider that deletes the session mid-run, simulating an admin deleting
      // a stuck session while the agent loop is still executing.
      @Injectable()
      class MidRunDeleteProvider extends BaseAgentProvider {
        readonly id = 'midrun-delete';
        readonly name = 'MidRunDelete';

        constructor(s: SessionsRepository, e: EventsRepository) {
          super(s, e);
        }
        async isAvailable() {
          return true;
        }
        async listModels(): Promise<[]> {
          return [];
        }
        protected async executePrompt(sessionId: string): Promise<void> {
          // Delete the session from the persistence layer underneath the loop.
          sessions.delete(sessionId);
          // Then resolve normally — the base provider will try to updateStatus
          // to IDLE on a session row that no longer exists.
        }
      }

      const raceProvider = new MidRunDeleteProvider(sessions, events);
      const created = sessions.create({ prompt: 'race me', provider: 'midrun-delete' });

      // The run must not throw "Session not found" out of run()/handleError —
      // that would escape as an unhandled rejection and crash the process.
      await expect(raceProvider.run(created.id, created.prompt, {})).resolves.toBeUndefined();
      expect(sessions.findById(created.id)).toBeNull();
    });

    it('does not throw when handleError runs against a deleted session', async () => {
      // Provider that deletes the session then throws, exercising the
      // handleError path against a missing row.
      @Injectable()
      class DeleteThenThrowProvider extends BaseAgentProvider {
        readonly id = 'delete-throw';
        readonly name = 'DeleteThenThrow';

        constructor(s: SessionsRepository, e: EventsRepository) {
          super(s, e);
        }
        async isAvailable() {
          return true;
        }
        async listModels(): Promise<[]> {
          return [];
        }
        protected async executePrompt(sessionId: string): Promise<void> {
          sessions.delete(sessionId);
          throw new Error('boom after delete');
        }
      }

      const raceProvider = new DeleteThenThrowProvider(sessions, events);
      const created = sessions.create({ prompt: 'fail after delete', provider: 'delete-throw' });

      await expect(raceProvider.run(created.id, created.prompt, {})).resolves.toBeUndefined();
      expect(sessions.findById(created.id)).toBeNull();
    });
  });
});
