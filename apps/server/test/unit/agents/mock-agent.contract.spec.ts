import { beforeAll, afterAll, describe, it, expect } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BaseAgentProvider } from '../../../src/agents/agents.base-provider';
import type { AgentRunContext, EventEmitter } from '../../../src/agents/agents.types';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { describeAgentProviderContract } from './provider-contract.suite';

/**
 * Reference provider used to prove the shared contract itself. It exercises the
 * BaseAgentProvider orchestration directly with a scripted stream — deltas via
 * the coalescing `pushEvent` pipe, then a terminal `assistant_message`, exactly
 * as a real adapter does.
 *
 * Deliberately NOT the real `providers/mock-agent.provider.ts`: the real Mock is
 * a real-time streaming demo engine (paced 8-char deltas slower than the 100ms
 * coalesce window, and no failure branch), so it structurally cannot satisfy the
 * scripted error/coalescing legs of this contract. The real Mock is covered by
 * `mock-agent.flag.spec.ts` (flag gating + streaming) and the level-5 smoke
 * (`bun run test:smoke-ui`) instead.
 */
class MockAgentProvider extends BaseAgentProvider {
  readonly id = 'mock';
  readonly name = 'Mock';

  /** Script for the next executePrompt: deltas to stream then the final text. */
  private script: { deltas: string[]; finalText: string } | null = null;
  private failNext = false;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async listModels(): Promise<[]> {
    return [];
  }

  arrangeSuccess(deltas: string[], finalText: string): void {
    this.script = { deltas, finalText };
    this.failNext = false;
  }

  arrangeError(): void {
    this.failNext = true;
    this.script = null;
  }

  protected async executePrompt(
    sessionId: string,
    _text: string,
    _isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('mock provider failure');
    }
    const script = this.script ?? { deltas: [], finalText: '' };
    for (const delta of script.deltas) {
      this.pushEvent(sessionId, 'assistant_delta', { delta }, context.emit);
    }
    // A non-delta event flushes the coalesced deltas first, then appends the
    // authoritative terminal text — same shape every real provider produces.
    this.pushEvent(sessionId, 'assistant_message', { text: script.finalText }, context.emit);
  }
}

describe('MockAgentProvider contract harness', () => {
  let module: TestingModule;
  let provider: MockAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-mock-contract-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
    }).compile();

    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
    provider = new MockAgentProvider(sessions, events);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  describeAgentProviderContract('mock', () => ({
    provider,
    sessions,
    events,
    createSession: (prompt) => sessions.create({ prompt, provider: 'mock' }),
    successDeltas: ['héllo 世界 ', '🚀 tokens'],
    successFinalText: 'héllo 世界 🚀 tokens',
    arrangeSuccess: (deltas, finalText) => provider.arrangeSuccess(deltas, finalText),
    arrangeError: () => provider.arrangeError(),
    // interrupt is not declared — a declared-off capability.
    exercisesInterrupt: false,
  }));
});

/** Unicode round-trip: the delta pipe must be byte-safe end to end. */
describe('MockAgentProvider unicode stream', () => {
  let module: TestingModule;
  let provider: MockAgentProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-mock-unicode-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
    }).compile();
    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
    provider = new MockAgentProvider(sessions, events);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('preserves multibyte unicode across the delta + terminal pipe', async () => {
    const created = sessions.create({ prompt: 'unicode', provider: 'mock' });
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const emit: EventEmitter = (event) => emitted.push(event);
    provider.arrangeSuccess(['café ', 'naïve 🧪'], 'café naïve 🧪');

    await provider.run(created.id, created.prompt, { emit });

    const streamed = events
      .list(created.id)
      .filter((event) => event.type === 'assistant_delta')
      .map((event) => (event.payload as { delta: string }).delta)
      .join('');
    expect(streamed).toBe('café naïve 🧪');
    const message = events
      .list(created.id)
      .findLast((event) => event.type === 'assistant_message');
    expect((message?.payload as { text: string }).text).toBe('café naïve 🧪');
  });

  it('drives RUNNING then IDLE on an empty prompt', async () => {
    const created = sessions.create({ prompt: '', provider: 'mock' });
    const emitted: Array<{ type: string; payload: unknown }> = [];
    provider.arrangeSuccess([], '');

    await provider.run(created.id, '', { emit: (e) => emitted.push(e) });

    expect(sessions.findById(created.id)?.status).toBe('IDLE');
    expect(events.list(created.id).some((e) => e.type === 'user_message')).toBe(true);
  });
});
