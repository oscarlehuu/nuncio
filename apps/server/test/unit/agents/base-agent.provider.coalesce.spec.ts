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
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';

type Step = { type: string; payload: unknown } | { waitMs: number };

@Injectable()
class ScriptedProvider extends BaseAgentProvider {
  readonly id = 'scripted';
  readonly name = 'Scripted';
  script: Step[] = [];

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
    for (const step of this.script) {
      if ('waitMs' in step) {
        await new Promise((resolve) => setTimeout(resolve, step.waitMs));
      } else {
        this.pushEvent(sessionId, step.type, step.payload, context.emit);
      }
    }
  }
}

describe('BaseAgentProvider delta coalescing', () => {
  let module: TestingModule;
  let provider: ScriptedProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-coalesce-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
    }).compile();

    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
    provider = new ScriptedProvider(sessions, events);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('merges a rapid burst of assistant deltas into one persisted row', async () => {
    provider.script = [
      { type: 'assistant_delta', payload: { delta: 'hel' } },
      { type: 'assistant_delta', payload: { delta: 'lo ' } },
      { type: 'assistant_delta', payload: { delta: 'world' } },
      { type: 'assistant_message', payload: { text: 'hello world' } },
    ];
    const created = sessions.create({ prompt: 'burst', provider: 'scripted' });
    const emitted: SessionEvent[] = [];

    await provider.run(created.id, created.prompt, { emit: (event) => emitted.push(event) });

    const persistedDeltas = events.list(created.id).filter((e) => e.type === 'assistant_delta');
    expect(persistedDeltas.length).toBe(1);
    expect((persistedDeltas[0].payload as { delta: string }).delta).toBe('hello world');

    const emittedDeltas = emitted.filter((e) => e.type === 'assistant_delta');
    expect(emittedDeltas.length).toBe(1);
    expect(emittedDeltas[0]).toEqual(persistedDeltas[0]);
  });

  it('flushes buffered deltas before any non-delta event to preserve order', async () => {
    provider.script = [
      { type: 'assistant_delta', payload: { delta: 'before tool' } },
      { type: 'tool_start', payload: { callId: 'c1', tool: 'bash' } },
      { type: 'assistant_delta', payload: { delta: 'after tool' } },
      { type: 'assistant_message', payload: { text: 'done' } },
    ];
    const created = sessions.create({ prompt: 'order', provider: 'scripted' });

    await provider.run(created.id, created.prompt, { emit: () => {} });

    const types = events
      .list(created.id)
      .map((e) => e.type)
      .filter((t) => ['assistant_delta', 'tool_start', 'assistant_message'].includes(t));
    expect(types).toEqual(['assistant_delta', 'tool_start', 'assistant_delta', 'assistant_message']);
  });

  it('does not merge thinking deltas into assistant deltas', async () => {
    provider.script = [
      { type: 'thinking_delta', payload: { thinkingId: 't1', delta: 'plan ' } },
      { type: 'thinking_delta', payload: { thinkingId: 't1', delta: 'more' } },
      { type: 'assistant_delta', payload: { delta: 'answer' } },
      { type: 'assistant_message', payload: { text: 'answer' } },
    ];
    const created = sessions.create({ prompt: 'think', provider: 'scripted' });

    await provider.run(created.id, created.prompt, { emit: () => {} });

    const rows = events
      .list(created.id)
      .filter((e) => e.type === 'thinking_delta' || e.type === 'assistant_delta');
    expect(rows.length).toBe(2);
    expect(rows[0].type).toBe('thinking_delta');
    expect((rows[0].payload as { delta: string; thinkingId: string }).delta).toBe('plan more');
    expect((rows[0].payload as { thinkingId: string }).thinkingId).toBe('t1');
    expect(rows[1].type).toBe('assistant_delta');
    expect((rows[1].payload as { delta: string }).delta).toBe('answer');
  });

  it('flushes a quiet buffer on the timer so slow streams still reach subscribers', async () => {
    provider.script = [
      { type: 'assistant_delta', payload: { delta: 'slow' } },
      { waitMs: 250 },
      { type: 'assistant_delta', payload: { delta: ' drip' } },
      { type: 'assistant_message', payload: { text: 'slow drip' } },
    ];
    const created = sessions.create({ prompt: 'slow', provider: 'scripted' });
    const emitted: SessionEvent[] = [];
    const emit: EventEmitter = (event) => emitted.push(event);

    const runPromise = provider.run(created.id, created.prompt, { emit });
    // Well past the flush interval but before the run completes: the first
    // delta must already be persisted and emitted.
    await new Promise((resolve) => setTimeout(resolve, 180));
    const midRun = emitted.filter((e) => e.type === 'assistant_delta');
    expect(midRun.length).toBe(1);
    expect((midRun[0].payload as { delta: string }).delta).toBe('slow');
    await runPromise;

    const persistedDeltas = events.list(created.id).filter((e) => e.type === 'assistant_delta');
    expect(persistedDeltas.map((e) => (e.payload as { delta: string }).delta)).toEqual([
      'slow',
      ' drip',
    ]);
  });
});
