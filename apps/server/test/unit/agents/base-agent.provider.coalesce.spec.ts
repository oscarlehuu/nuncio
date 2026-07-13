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

  /** Test hook: buffer a single delta without running a full prompt. */
  bufferDelta(sessionId: string, delta: string, emit?: EventEmitter): void {
    this.pushEvent(sessionId, 'assistant_delta', { delta }, emit);
  }

  /** Test hook: emit any provider-neutral event without running a prompt. */
  bufferEvent(sessionId: string, type: string, payload: unknown, emit?: EventEmitter): void {
    this.pushEvent(sessionId, type, payload, emit);
  }

  protected async executePrompt(
    sessionId: string,
    _text: string,
    _isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void> {
    let preview = '';
    for (const step of this.script) {
      if ('waitMs' in step) {
        await new Promise((resolve) => setTimeout(resolve, step.waitMs));
      } else {
        if (step.type === 'assistant_delta') {
          preview += String((step.payload as { delta?: unknown }).delta ?? '');
          this.touchPreview(sessionId, preview);
        }
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

  it('persists a rapid burst as an immediate head plus one coalesced tail', async () => {
    provider.script = [
      { type: 'assistant_delta', payload: { delta: 'hel' } },
      { type: 'assistant_delta', payload: { delta: 'lo ' } },
      { type: 'assistant_delta', payload: { delta: 'world' } },
      { type: 'assistant_message', payload: { text: 'hello world' } },
    ];
    const created = sessions.create({ prompt: 'burst', provider: 'scripted' });
    const emitted: Parameters<NonNullable<EventEmitter>>[0][] = [];

    await provider.run(created.id, created.prompt, { emit: (event) => emitted.push(event) });

    const persistedDeltas = events.list(created.id).filter((e) => e.type === 'assistant_delta');
    expect(persistedDeltas.map((event) => (event.payload as { delta: string }).delta)).toEqual([
      'hel',
      'lo world',
    ]);

    const emittedDeltas = emitted.filter((e) => e.type === 'assistant_delta');
    expect(emittedDeltas).toEqual(persistedDeltas);
  });

  it('persists and emits the first delta immediately while coalescing the matching tail', () => {
    const created = sessions.create({ prompt: 'fast durable head', provider: 'scripted' });
    const emitted: Parameters<NonNullable<EventEmitter>>[0][] = [];
    const emit: EventEmitter = (event) => emitted.push(event);

    provider.bufferDelta(created.id, 'head', emit);

    let persisted = events.list(created.id).filter((event) => event.type === 'assistant_delta');
    expect(persisted.map((event) => (event.payload as { delta: string }).delta)).toEqual(['head']);
    expect(emitted).toEqual(persisted);

    provider.bufferDelta(created.id, 'tail-a', emit);
    provider.bufferDelta(created.id, 'tail-b', emit);
    persisted = events.list(created.id).filter((event) => event.type === 'assistant_delta');
    expect(persisted.map((event) => (event.payload as { delta: string }).delta)).toEqual(['head']);

    provider.flushPendingEvents(created.id);
    persisted = events.list(created.id).filter((event) => event.type === 'assistant_delta');
    expect(persisted.map((event) => (event.payload as { delta: string }).delta)).toEqual([
      'head',
      'tail-atail-b',
    ]);
    expect(emitted).toEqual(persisted);
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

  it('flushPendingEvents persists a buffered delta immediately, before a later append', () => {
    const created = sessions.create({ prompt: 'flush', provider: 'scripted' });
    provider.bufferDelta(created.id, 'head');
    provider.bufferDelta(created.id, 'buffered');
    // The segment head is durable; only the matching tail remains buffered.
    expect(events.list(created.id).filter((e) => e.type === 'assistant_delta')).toHaveLength(1);

    provider.flushPendingEvents(created.id);
    const deltas = events.list(created.id).filter((e) => e.type === 'assistant_delta');
    expect(deltas).toHaveLength(2);
    expect(deltas.map((event) => (event.payload as { delta: string }).delta)).toEqual([
      'head',
      'buffered',
    ]);

    // An out-of-band append now lands strictly after the flushed delta.
    const digest = events.append(created.id, 'task_completed', { taskId: 't', status: 'DONE' });
    expect(digest.seq).toBeGreaterThan(deltas[0].seq);
  });

  it('flushPendingEvents is a no-op when nothing is buffered', () => {
    const created = sessions.create({ prompt: 'empty-flush', provider: 'scripted' });
    expect(() => provider.flushPendingEvents(created.id)).not.toThrow();
    expect(events.list(created.id).filter((e) => e.type === 'assistant_delta')).toHaveLength(0);
  });

  it('keeps a synchronously failed delta append retryable and emits it exactly once', () => {
    const created = sessions.create({ prompt: 'retry flush', provider: 'scripted' });
    const emitted: Parameters<NonNullable<EventEmitter>>[0][] = [];
    const originalAppend = events.append.bind(events);
    let failNextDelta = true;
    events.append = ((sessionId: string, type: string, payload: unknown) => {
      if (type === 'assistant_delta' && failNextDelta) {
        failNextDelta = false;
        throw new Error('temporary sqlite failure');
      }
      return originalAppend(sessionId, type, payload);
    }) as EventsRepository['append'];

    try {
      provider.bufferDelta(created.id, 'retry me', (event) => emitted.push(event));
      expect(events.list(created.id).filter((event) => event.type === 'assistant_delta')).toHaveLength(0);
      expect(emitted).toHaveLength(0);
      provider.flushPendingEvents(created.id);
    } finally {
      events.append = originalAppend as EventsRepository['append'];
    }

    const deltas = events.list(created.id).filter((event) => event.type === 'assistant_delta');
    expect(deltas).toHaveLength(1);
    expect((deltas[0]!.payload as { delta: string }).delta).toBe('retry me');
    expect(emitted.filter((event) => event.type === 'assistant_delta')).toHaveLength(1);
  });

  it('retries a quiet-timer append failure without losing or duplicating the tail', async () => {
    const created = sessions.create({ prompt: 'timer retry', provider: 'scripted' });
    provider.bufferDelta(created.id, 'head');
    const originalAppend = events.append.bind(events);
    let failures = 1;
    events.append = ((sessionId: string, type: string, payload: unknown) => {
      if (type === 'assistant_delta' && failures-- > 0) {
        throw new Error('temporary timer failure');
      }
      return originalAppend(sessionId, type, payload);
    }) as EventsRepository['append'];

    try {
      provider.bufferDelta(created.id, 'timer tail');
      const started = Date.now();
      while (
        events.list(created.id).filter((event) => event.type === 'assistant_delta').length < 2 &&
        Date.now() - started < 1000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      events.append = originalAppend as EventsRepository['append'];
    }

    const deltas = events.list(created.id).filter((event) => event.type === 'assistant_delta');
    expect(deltas.map((event) => (event.payload as { delta: string }).delta)).toEqual([
      'head',
      'timer tail',
    ]);
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
    expect(rows.length).toBe(3);
    expect(rows[0].type).toBe('thinking_delta');
    expect((rows[0].payload as { delta: string; thinkingId: string }).delta).toBe('plan ');
    expect((rows[0].payload as { thinkingId: string }).thinkingId).toBe('t1');
    expect(rows[1].type).toBe('thinking_delta');
    expect((rows[1].payload as { delta: string; thinkingId: string }).delta).toBe('more');
    expect((rows[1].payload as { thinkingId: string }).thinkingId).toBe('t1');
    expect(rows[2].type).toBe('assistant_delta');
    expect((rows[2].payload as { delta: string }).delta).toBe('answer');
  });

  it('starts a new immediate head after a non-delta boundary', () => {
    const created = sessions.create({ prompt: 'tool boundary', provider: 'scripted' });
    const emitted: Parameters<NonNullable<EventEmitter>>[0][] = [];
    const emit: EventEmitter = (event) => emitted.push(event);

    provider.bufferDelta(created.id, 'before-', emit);
    provider.bufferDelta(created.id, 'tool', emit);
    provider.bufferEvent(created.id, 'tool_start', { callId: 'c1', tool: 'bash' }, emit);
    provider.bufferDelta(created.id, 'after', emit);

    const relevant = events.list(created.id).filter((event) =>
      event.type === 'assistant_delta' || event.type === 'tool_start'
    );
    expect(relevant.map((event) => event.type)).toEqual([
      'assistant_delta',
      'assistant_delta',
      'tool_start',
      'assistant_delta',
    ]);
    expect(
      relevant
        .filter((event) => event.type === 'assistant_delta')
        .map((event) => (event.payload as { delta: string }).delta),
    ).toEqual(['before-', 'tool', 'after']);
    expect(emitted).toEqual(relevant);
  });

  it('starts a new immediate thinking head when its non-delta base changes', () => {
    const created = sessions.create({ prompt: 'thinking boundary', provider: 'scripted' });

    provider.bufferEvent(created.id, 'thinking_delta', { thinkingId: 't1', delta: 'head-1' });
    provider.bufferEvent(created.id, 'thinking_delta', { thinkingId: 't1', delta: 'tail-1' });
    provider.bufferEvent(created.id, 'thinking_delta', { thinkingId: 't2', delta: 'head-2' });

    const thinking = events.list(created.id).filter((event) => event.type === 'thinking_delta');
    expect(
      thinking.map((event) => ({
        thinkingId: (event.payload as { thinkingId: string }).thinkingId,
        delta: (event.payload as { delta: string }).delta,
      })),
    ).toEqual([
      { thinkingId: 't1', delta: 'head-1' },
      { thinkingId: 't1', delta: 'tail-1' },
      { thinkingId: 't2', delta: 'head-2' },
    ]);
  });

  it('resets segment state on dispose so a reused session gets a new immediate head', () => {
    const created = sessions.create({ prompt: 'dispose boundary', provider: 'scripted' });

    provider.bufferDelta(created.id, 'first');
    provider.bufferDelta(created.id, '-tail');
    provider.dispose(created.id);
    provider.bufferDelta(created.id, 'second');

    const deltas = events
      .list(created.id)
      .filter((event) => event.type === 'assistant_delta')
      .map((event) => (event.payload as { delta: string }).delta);
    expect(deltas).toEqual(['first', '-tail', 'second']);
    expect(provider.pendingEventSessionIds()).not.toContain(created.id);
  });

  it('flushes a quiet buffer on the timer so slow streams still reach subscribers', async () => {
    provider.script = [
      { type: 'assistant_delta', payload: { delta: 'slow' } },
      { waitMs: 250 },
      { type: 'assistant_delta', payload: { delta: ' drip' } },
      { type: 'assistant_message', payload: { text: 'slow drip' } },
    ];
    const created = sessions.create({ prompt: 'slow', provider: 'scripted' });
    const emitted: Parameters<NonNullable<EventEmitter>>[0][] = [];
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

  it('throttles preview writes for a rapid delta burst and flushes the final text', async () => {
    provider.script = [
      ...Array.from({ length: 12 }, (_, i) => ({
        type: 'assistant_delta',
        payload: { delta: String(i % 10) },
      })),
      { type: 'assistant_message', payload: { text: '012345678901' } },
    ];
    const created = sessions.create({ prompt: 'preview burst', provider: 'scripted' });
    const originalTouchPreview = sessions.touchPreview.bind(sessions);
    const previews: string[] = [];
    sessions.touchPreview = ((id: string, preview: string) => {
      previews.push(preview);
      originalTouchPreview(id, preview);
    }) as SessionsRepository['touchPreview'];

    try {
      await provider.run(created.id, created.prompt, { emit: () => {} });
    } finally {
      sessions.touchPreview = originalTouchPreview as SessionsRepository['touchPreview'];
    }

    expect(previews.length).toBeLessThanOrEqual(2);
    expect(previews.at(-1)).toBe('012345678901');
    expect(sessions.findById(created.id)?.preview).toBe('012345678901');
  });
});
