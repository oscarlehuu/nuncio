import { Injectable } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentRunContext, EventEmitter } from '../../../src/agents/agents.types';
import { BaseAgentProvider } from '../../../src/agents/agents.base-provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { Test, TestingModule } from '@nestjs/testing';

// Mirror of the private constant in agents.base-provider.ts. Kept local so the
// boundary test fails loudly if the production constant ever changes without
// the test being revisited.
const DELTA_FLUSH_MAX_CHARS = 2000;

type Step =
  | { type: string; payload: unknown }
  | { throw: string };

@Injectable()
class ScriptedTailProvider extends BaseAgentProvider {
  readonly id = 'scripted-tail';
  readonly name = 'Scripted Tail';
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
      if ('throw' in step) {
        // A provider stream that dies mid-message: deltas are already buffered
        // but no terminal event follows. The buffered tail must not be lost.
        throw new Error(step.throw);
      }
      this.pushEvent(sessionId, step.type, step.payload, context.emit);
    }
  }
}

describe('BaseAgentProvider streamed-tail preservation', () => {
  let module: TestingModule;
  let provider: ScriptedTailProvider;
  let sessions: SessionsRepository;
  let events: EventsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-stream-tail-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
    }).compile();

    sessions = module.get(SessionsRepository);
    events = module.get(EventsRepository);
    provider = new ScriptedTailProvider(sessions, events);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('flushes the buffered delta tail before the error event when a turn throws mid-stream', async () => {
    // Guards against a lost streamed tail on the error path: if the provider
    // throws with a delta still buffered, the persisted transcript must still
    // contain that tail, and it must be ordered before the error event so the
    // renderer shows the partial answer, then the failure.
    provider.script = [
      { type: 'assistant_delta', payload: { delta: 'partial answer so far' } },
      { throw: 'stream died' },
    ];
    const created = sessions.create({ prompt: 'error tail', provider: 'scripted-tail' });
    const emitted: Parameters<NonNullable<EventEmitter>>[0][] = [];

    await provider.run(created.id, created.prompt, { emit: (event) => emitted.push(event) });

    const persisted = events.list(created.id);
    const deltas = persisted.filter((e) => e.type === 'assistant_delta');
    expect(deltas.length).toBe(1);
    expect((deltas[0].payload as { delta: string }).delta).toBe('partial answer so far');

    // Tail is ordered before the error marker (no interleaving, nothing dropped).
    const relevant = persisted
      .map((e) => e.type)
      .filter((t) => t === 'assistant_delta' || t === 'error');
    expect(relevant).toEqual(['assistant_delta', 'error']);

    const errorEvent = persisted.find((e) => e.type === 'error');
    expect((errorEvent?.payload as { message: string }).message).toBe('stream died');

    // The emitted (live) stream carries the same tail before the error.
    const emittedRelevant = emitted
      .map((e) => e.type)
      .filter((t) => t === 'assistant_delta' || t === 'error');
    expect(emittedRelevant).toEqual(['assistant_delta', 'error']);
  });

  it('flushes exactly when a delta append reaches the max-chars boundary, losing no character', async () => {
    // Boundary: DELTA_FLUSH_MAX_CHARS=2000, flush fires on `length >= max`
    // AFTER an append (the first delta of a buffer never self-flushes, however
    // large — the size check only runs on subsequent appends). Here delta one
    // seeds the buffer at 1999, delta two appends to hit exactly 2000 → flush.
    // Delta three then seeds a fresh buffer that drains at turn end. The three
    // persisted rows must reconstruct the text with no char swallowed at the
    // split and none duplicated.
    const seed = 'a'.repeat(DELTA_FLUSH_MAX_CHARS - 1); // 1999
    const trip = 'Z'; // append that reaches exactly 2000
    const after = 'TAIL';
    provider.script = [
      { type: 'assistant_delta', payload: { delta: seed } },
      { type: 'assistant_delta', payload: { delta: trip } },
      { type: 'assistant_delta', payload: { delta: after } },
      { type: 'assistant_message', payload: { text: seed + trip + after } },
    ];
    const created = sessions.create({ prompt: 'boundary', provider: 'scripted-tail' });

    await provider.run(created.id, created.prompt, { emit: () => {} });

    const deltas = events
      .list(created.id)
      .filter((e) => e.type === 'assistant_delta')
      .map((e) => (e.payload as { delta: string }).delta);
    // Row one is the exactly-2000 chunk that tripped `>= max`; row two is the
    // tail flushed at turn end. Full text is preserved across the split.
    expect(deltas).toEqual([seed + trip, after]);
    expect(deltas[0].length).toBe(DELTA_FLUSH_MAX_CHARS);
    expect(deltas.join('')).toBe(seed + trip + after);
    expect(deltas.join('').length).toBe(DELTA_FLUSH_MAX_CHARS + after.length);
  });

  it('does not flush one character short of the max-chars boundary', async () => {
    // The below-boundary neighbour: a buffer that only ever reaches 1999 must
    // NOT flush early; the whole message stays a single coalesced row. Guards an
    // off-by-one that would either fragment (harmless) or, if the comparison
    // were inverted, drop a char.
    const seed = 'b'.repeat(DELTA_FLUSH_MAX_CHARS - 2); // 1998
    provider.script = [
      { type: 'assistant_delta', payload: { delta: seed } },
      { type: 'assistant_delta', payload: { delta: 'x' } }, // buffer now 1999, no flush
      { type: 'assistant_message', payload: { text: seed + 'x' } },
    ];
    const created = sessions.create({ prompt: 'below boundary', provider: 'scripted-tail' });

    await provider.run(created.id, created.prompt, { emit: () => {} });

    const deltas = events
      .list(created.id)
      .filter((e) => e.type === 'assistant_delta')
      .map((e) => (e.payload as { delta: string }).delta);
    // Buffer stops at 1999 (< 2000), so nothing flushes early: one row at turn end.
    expect(deltas.length).toBe(1);
    expect(deltas[0]).toBe(seed + 'x');
    expect(deltas[0].length).toBe(DELTA_FLUSH_MAX_CHARS - 1);
  });
});
