import { Injectable } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentRunContext, EventEmitter } from '../../../src/agents/agents.types';
import { BaseAgentProvider, RetainedEventFlushError } from '../../../src/agents/agents.base-provider';
import { MockAgentProvider } from '../../../src/agents/providers/mock-agent.provider';
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
  executions = 0;

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
    this.executions += 1;
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

class OverlappingRunProvider extends BaseAgentProvider {
  readonly id = 'overlapping';
  readonly name = 'Overlapping';
  readonly contexts: AgentRunContext[] = [];
  private readonly releases: Array<() => void> = [];
  released = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async listModels(): Promise<[]> {
    return [];
  }

  emitFrom(runIndex: number, delta: string): void {
    this.pushEvent(
      this.sessionId,
      'assistant_delta',
      { delta },
      this.contexts[runIndex]?.emit,
    );
  }

  protected disposeRuntime(): void {
    this.released += 1;
  }

  release(runIndex: number): void {
    this.releases[runIndex]?.();
  }

  sessionId = '';

  protected async executePrompt(
    sessionId: string,
    _text: string,
    _isSteer: boolean,
    context: AgentRunContext,
  ): Promise<void> {
    this.sessionId = sessionId;
    this.contexts.push(context);
    await new Promise<void>((resolve) => this.releases.push(resolve));
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
    // The logical segment head commits immediately. Its coalesced tail still
    // flushes exactly at 2,000 chars, then a later tail drains at turn end.
    const head = 'H';
    const seed = 'a'.repeat(DELTA_FLUSH_MAX_CHARS - 1); // 1999
    const trip = 'Z'; // append that reaches exactly 2000
    const after = 'TAIL';
    provider.script = [
      { type: 'assistant_delta', payload: { delta: head } },
      { type: 'assistant_delta', payload: { delta: seed } },
      { type: 'assistant_delta', payload: { delta: trip } },
      { type: 'assistant_delta', payload: { delta: after } },
      { type: 'assistant_message', payload: { text: head + seed + trip + after } },
    ];
    const created = sessions.create({ prompt: 'boundary', provider: 'scripted-tail' });

    await provider.run(created.id, created.prompt, { emit: () => {} });

    const deltas = events
      .list(created.id)
      .filter((e) => e.type === 'assistant_delta')
      .map((e) => (e.payload as { delta: string }).delta);
    expect(deltas).toEqual([head, seed + trip, after]);
    expect(deltas[1].length).toBe(DELTA_FLUSH_MAX_CHARS);
    expect(deltas.join('')).toBe(head + seed + trip + after);
    expect(deltas.join('').length).toBe(head.length + DELTA_FLUSH_MAX_CHARS + after.length);
  });

  it('does not flush one character short of the max-chars boundary', async () => {
    const head = 'H';
    const seed = 'b'.repeat(DELTA_FLUSH_MAX_CHARS - 2); // 1998
    provider.script = [
      { type: 'assistant_delta', payload: { delta: head } },
      { type: 'assistant_delta', payload: { delta: seed } },
      { type: 'assistant_delta', payload: { delta: 'x' } }, // buffer now 1999, no flush
      { type: 'assistant_message', payload: { text: head + seed + 'x' } },
    ];
    const created = sessions.create({ prompt: 'below boundary', provider: 'scripted-tail' });

    await provider.run(created.id, created.prompt, { emit: () => {} });

    const deltas = events
      .list(created.id)
      .filter((e) => e.type === 'assistant_delta')
      .map((e) => (e.payload as { delta: string }).delta);
    expect(deltas).toEqual([head, seed + 'x']);
    expect(deltas[1].length).toBe(DELTA_FLUSH_MAX_CHARS - 1);
  });

  it('drops callbacks from an older run generation after a replacement run starts', async () => {
    const overlapping = new OverlappingRunProvider(sessions, events);
    const created = sessions.create({ prompt: 'first run', provider: 'overlapping' });
    const first = overlapping.run(created.id, created.prompt, { emit: () => {} });
    while (overlapping.contexts.length < 1) await Promise.resolve();

    // Simulate the service force-idling a provider that did not unwind, then
    // starting the replacement run while the old SDK callback can still fire.
    sessions.updateStatus(created.id, 'IDLE');
    const second = overlapping.steer(created.id, 'replacement run', { emit: () => {} });
    while (overlapping.contexts.length < 2) await Promise.resolve();

    overlapping.emitFrom(0, 'stale callback');
    overlapping.emitFrom(1, 'fresh callback');
    overlapping.release(1);
    await second;
    overlapping.release(0);
    await first;

    const text = events
      .list(created.id)
      .filter((event) => event.type === 'assistant_delta')
      .map((event) => (event.payload as { delta: string }).delta)
      .join('');
    expect(text).toBe('fresh callback');
    expect(sessions.findById(created.id)?.status).toBe('IDLE');
  });

  it('releases the runtime and retains the accepted tail when dispose flushing fails', async () => {
    const overlapping = new OverlappingRunProvider(sessions, events);
    const created = sessions.create({ prompt: 'dispose retry', provider: 'overlapping' });
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const running = overlapping.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event),
    });
    while (overlapping.contexts.length < 1) await Promise.resolve();
    overlapping.emitFrom(0, 'durable head: ');
    overlapping.emitFrom(0, 'accepted before dispose');

    const originalAppend = events.append.bind(events);
    events.append = ((sessionId: string, type: string, payload: unknown) => {
      if (type === 'assistant_delta') throw new Error('persistent sqlite failure');
      return originalAppend(sessionId, type, payload);
    }) as EventsRepository['append'];
    let disposeError: unknown;
    try {
      overlapping.dispose(created.id);
    } catch (error) {
      disposeError = error;
    } finally {
      events.append = originalAppend as EventsRepository['append'];
    }

    expect(disposeError).toBeInstanceOf(Error);
    expect(overlapping.released).toBe(1);
    overlapping.flushPendingEvents(created.id);
    overlapping.release(0);
    await running;
    const deltas = events.list(created.id).filter((event) => event.type === 'assistant_delta');
    expect(
      deltas.map((event) => (event.payload as { delta: string }).delta).join(''),
    ).toBe('durable head: accepted before dispose');
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'assistant_delta',
        payload: { delta: 'accepted before dispose' },
      }),
    );
  });

  it('does not recreate segment metadata when a disposed retained tail recovers', async () => {
    const overlapping = new OverlappingRunProvider(sessions, events);
    const created = sessions.create({ prompt: 'dispose metadata recovery', provider: 'overlapping' });
    const running = overlapping.run(created.id, created.prompt, { emit: () => {} });
    while (overlapping.contexts.length < 1) await Promise.resolve();
    overlapping.emitFrom(0, 'durable head');

    const originalAppend = events.append.bind(events);
    events.append = ((sessionId: string, type: string, payload: unknown) => {
      if (type === 'assistant_delta') throw new Error('sqlite unavailable during dispose');
      return originalAppend(sessionId, type, payload);
    }) as EventsRepository['append'];

    try {
      overlapping.emitFrom(0, 'a'.repeat(DELTA_FLUSH_MAX_CHARS));
      overlapping.emitFrom(0, 'retained behind full tail');
      expect(() => overlapping.dispose(created.id)).toThrow('sqlite unavailable during dispose');
    } finally {
      events.append = originalAppend as EventsRepository['append'];
    }

    overlapping.flushPendingEvents(created.id);
    const segmentState = (
      overlapping as unknown as { deltaSegments: Map<string, unknown> }
    ).deltaSegments;
    expect(overlapping.pendingEventSessionIds()).not.toContain(created.id);
    expect(segmentState.has(created.id)).toBe(false);

    overlapping.release(0);
    await running;
  });

  it('can cancel a retained delta retry when shutdown makes persistence unavailable', async () => {
    const overlapping = new OverlappingRunProvider(sessions, events);
    const created = sessions.create({ prompt: 'shutdown retry', provider: 'overlapping' });
    const running = overlapping.run(created.id, created.prompt, { emit: () => {} });
    while (overlapping.contexts.length < 1) await Promise.resolve();
    overlapping.emitFrom(0, 'durable head: ');
    overlapping.emitFrom(0, 'accepted before shutdown');

    const originalAppend = events.append.bind(events);
    let attempts = 0;
    events.append = ((sessionId: string, type: string, payload: unknown) => {
      if (type === 'assistant_delta') {
        attempts += 1;
        throw new Error('sqlite already closed');
      }
      return originalAppend(sessionId, type, payload);
    }) as EventsRepository['append'];

    try {
      expect(() => overlapping.dispose(created.id)).toThrow('sqlite already closed');
      overlapping.cancelPendingEventRetries(created.id);
      await new Promise((resolve) => setTimeout(resolve, 260));
      expect(attempts).toBe(1);
    } finally {
      events.append = originalAppend as EventsRepository['append'];
      overlapping.flushPendingEvents(created.id);
      overlapping.release(0);
      await running;
    }
  });

  it('does not treat a closed-database seq-zero sentinel as a committed tail', async () => {
    const overlapping = new OverlappingRunProvider(sessions, events);
    const created = sessions.create({ prompt: 'closed database sentinel', provider: 'overlapping' });
    const emitted: Array<{ type: string; payload: unknown; seq?: number; createdAt?: number }> = [];
    const running = overlapping.run(created.id, created.prompt, {
      emit: (event) => emitted.push(event),
    });
    while (overlapping.contexts.length < 1) await Promise.resolve();
    overlapping.emitFrom(0, 'durable head: ');
    overlapping.emitFrom(0, 'must remain retained');
    const emittedBeforeFailure = emitted.filter((event) => event.type === 'assistant_delta').length;

    const originalAppend = events.append.bind(events);
    events.append = ((sessionId: string, type: string, payload: unknown) => {
      if (type === 'assistant_delta') {
        return { seq: 0, type, payload, createdAt: Date.now() };
      }
      return originalAppend(sessionId, type, payload);
    }) as EventsRepository['append'];

    try {
      expect(() => overlapping.flushPendingEvents(created.id)).toThrow(RetainedEventFlushError);
      expect(overlapping.pendingEventSessionIds()).toContain(created.id);
      expect(emitted.filter((event) => event.type === 'assistant_delta')).toHaveLength(
        emittedBeforeFailure,
      );
    } finally {
      events.append = originalAppend as EventsRepository['append'];
    }

    overlapping.flushPendingEvents(created.id);
    expect(overlapping.pendingEventSessionIds()).not.toContain(created.id);
    expect(
      events
        .list(created.id)
        .filter((event) => event.type === 'assistant_delta')
        .map((event) => (event.payload as { delta: string }).delta)
        .join(''),
    ).toBe('durable head: must remain retained');
    overlapping.release(0);
    await running;
  });

  it('retains terminal status and error events behind a delta until storage recovers', async () => {
    provider.script = [
      { type: 'assistant_delta', payload: { delta: 'accepted before storage failed' } },
      { throw: 'provider stream failed' },
    ];
    const created = sessions.create({ prompt: 'terminal retention', provider: 'scripted-tail' });
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const originalAppend = events.append.bind(events);
    let remainingDeltaFailures = 2;
    events.append = ((sessionId: string, type: string, payload: unknown) => {
      if (type === 'assistant_delta' && remainingDeltaFailures-- > 0) {
        throw new Error('sqlite temporarily unavailable');
      }
      return originalAppend(sessionId, type, payload);
    }) as EventsRepository['append'];

    try {
      await provider.run(created.id, created.prompt, {
        emit: (event) => emitted.push(event),
      });
      const started = Date.now();
      while (
        !events.list(created.id).some((event) => event.type === 'error') &&
        Date.now() - started < 1_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      events.append = originalAppend as EventsRepository['append'];
    }

    const terminal = events
      .list(created.id)
      .filter((event) => event.type === 'assistant_delta' || event.type === 'status' || event.type === 'error')
      .slice(-3);
    expect(terminal.map((event) => event.type)).toEqual(['assistant_delta', 'status', 'error']);
    expect(terminal[1]?.payload).toEqual({ status: 'ERROR' });
    expect((terminal[2]?.payload as { message: string }).message).toBe('provider stream failed');
    expect(emitted.slice(-3).map((event) => event.type)).toEqual(['assistant_delta', 'status', 'error']);
  });

  it('does not resolve the turn before retained terminal events can precede post-turn work', async () => {
    provider.script = [
      { type: 'assistant_delta', payload: { delta: 'answer before verification' } },
      { type: 'assistant_message', payload: { text: 'answer before verification' } },
    ];
    const created = sessions.create({ prompt: 'post-turn ordering', provider: 'scripted-tail' });
    const originalAppend = events.append.bind(events);
    let messageFailures = 2;
    events.append = ((sessionId: string, type: string, payload: unknown) => {
      if (type === 'assistant_message' && messageFailures-- > 0) {
        throw new Error('assistant terminal temporarily unavailable');
      }
      return originalAppend(sessionId, type, payload);
    }) as EventsRepository['append'];

    let runSettled = false;
    const running = provider.run(created.id, created.prompt, { emit: () => {} }).then(() => {
      runSettled = true;
      originalAppend(created.id, 'verify_start', { command: 'bun test' });
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(runSettled).toBe(false);

    try {
      await running;
    } finally {
      events.append = originalAppend as EventsRepository['append'];
    }
    const ordered = events
      .list(created.id)
      .filter((event) => (
        event.type === 'assistant_message' ||
        (event.type === 'status' && (event.payload as { status?: string }).status === 'IDLE') ||
        event.type === 'verify_start'
      ));
    expect(ordered.map((event) => event.type)).toEqual(['assistant_message', 'status', 'verify_start']);
  });

  it('keeps the session RUNNING until a retained IDLE event becomes durable', async () => {
    provider.script = [
      { type: 'assistant_message', payload: { text: 'done after storage recovery' } },
    ];
    const created = sessions.create({ prompt: 'terminal row ordering', provider: 'scripted-tail' });
    const originalAppend = events.append.bind(events);
    let blockIdle = true;
    const rowStatusAtFanout: string[] = [];
    events.append = ((sessionId: string, type: string, payload: unknown, notify?: boolean) => {
      if (type === 'status' && (payload as { status?: string }).status === 'IDLE' && blockIdle) {
        throw new Error('idle event temporarily unavailable');
      }
      return originalAppend(sessionId, type, payload, notify);
    }) as EventsRepository['append'];

    const running = provider.run(created.id, created.prompt, {
      emit: (event) => {
        if (event.type === 'status' && (event.payload as { status?: string }).status === 'IDLE') {
          rowStatusAtFanout.push(sessions.findById(created.id)?.status ?? 'missing');
        }
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sessions.findById(created.id)?.status).toBe('RUNNING');
    blockIdle = false;
    await running;
    events.append = originalAppend as EventsRepository['append'];
    expect(sessions.findById(created.id)?.status).toBe('IDLE');
    expect(rowStatusAtFanout).toEqual(['IDLE']);
  });

  it('retries terminal settlement atomically instead of misclassifying a successful turn', async () => {
    provider.script = [{ type: 'assistant_message', payload: { text: 'completed successfully' } }];
    const created = sessions.create({ prompt: 'atomic terminal settlement', provider: 'scripted-tail' });
    const originalUpdateStatus = sessions.updateStatus.bind(sessions);
    let idleFailures = 1;
    sessions.updateStatus = ((sessionId: string, status: Parameters<SessionsRepository['updateStatus']>[1]) => {
      if (status === 'IDLE' && idleFailures-- > 0) throw new Error('transient status failure');
      return originalUpdateStatus(sessionId, status);
    }) as SessionsRepository['updateStatus'];

    try {
      await provider.run(created.id, created.prompt, { emit: () => {} });
    } finally {
      sessions.updateStatus = originalUpdateStatus as SessionsRepository['updateStatus'];
    }

    expect(sessions.findById(created.id)?.status).toBe('IDLE');
    expect(events.list(created.id).filter((event) => event.type === 'status')).toEqual([
      expect.objectContaining({ payload: { status: 'RUNNING' } }),
      expect.objectContaining({ payload: { status: 'IDLE' } }),
    ]);
    expect(events.list(created.id).some((event) => event.type === 'error')).toBe(false);
  });

  it('does not invoke the provider until the initiating input event is durable', async () => {
    provider.script = [{ type: 'assistant_message', payload: { text: 'after input' } }];
    provider.executions = 0;
    const created = sessions.create({ prompt: 'durable input first', provider: 'scripted-tail' });
    const originalAppend = events.append.bind(events);
    let blockInput = true;
    events.append = ((sessionId: string, type: string, payload: unknown, notify?: boolean) => {
      if (type === 'user_message' && blockInput) throw new Error('input storage unavailable');
      return originalAppend(sessionId, type, payload, notify);
    }) as EventsRepository['append'];
    const running = provider.run(created.id, created.prompt, { emit: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(provider.executions).toBe(0);
    blockInput = false;
    await running;
    events.append = originalAppend as EventsRepository['append'];
    expect(provider.executions).toBe(1);
  });

  it('keeps later deltas in bounded ordered chunks while a full buffer retries', async () => {
    const overlapping = new OverlappingRunProvider(sessions, events);
    const created = sessions.create({ prompt: 'bounded retry chunks', provider: 'overlapping' });
    const running = overlapping.run(created.id, created.prompt, { emit: () => {} });
    while (overlapping.contexts.length < 1) await Promise.resolve();
    overlapping.emitFrom(0, 'H');

    const originalAppend = events.append.bind(events);
    let failures = 1;
    events.append = ((sessionId: string, type: string, payload: unknown) => {
      if (type === 'assistant_delta' && failures-- > 0) throw new Error('sqlite temporarily busy');
      return originalAppend(sessionId, type, payload);
    }) as EventsRepository['append'];
    overlapping.emitFrom(0, 'a'.repeat(DELTA_FLUSH_MAX_CHARS - 1));
    overlapping.emitFrom(0, 'Z');
    events.append = originalAppend as EventsRepository['append'];

    overlapping.emitFrom(0, 'TAIL');
    overlapping.flushPendingEvents(created.id);
    const chunks = events
      .list(created.id)
      .filter((event) => event.type === 'assistant_delta')
      .map((event) => (event.payload as { delta: string }).delta);
    expect(chunks.map((chunk) => chunk.length)).toEqual([1, DELTA_FLUSH_MAX_CHARS, 4]);
    expect(chunks.join('')).toBe(`H${'a'.repeat(DELTA_FLUSH_MAX_CHARS - 1)}ZTAIL`);

    overlapping.release(0);
    await running;
  });

  it('fences the runtime when a persistent outage fills the retained-event budget', async () => {
    const overlapping = new OverlappingRunProvider(sessions, events);
    const created = sessions.create({ prompt: 'bounded retained outage', provider: 'overlapping' });
    const running = overlapping.run(created.id, created.prompt, { emit: () => {} });
    while (overlapping.contexts.length < 1) await Promise.resolve();

    const originalAppend = events.append.bind(events);
    events.append = ((sessionId: string, type: string, payload: unknown) => {
      if (type === 'assistant_delta') throw new Error('disk full');
      return originalAppend(sessionId, type, payload);
    }) as EventsRepository['append'];
    try {
      overlapping.emitFrom(0, 'a'.repeat(2000));
      expect(() => {
        for (let i = 0; i < 200; i += 1) overlapping.emitFrom(0, 'b'.repeat(2000));
      }).toThrow('Retained event buffer exceeded');
      expect(overlapping.released).toBe(1);
      events.append = originalAppend as EventsRepository['append'];
      overlapping.flushPendingEvents(created.id);
      expect(events.list(created.id).some((event) => event.type === 'assistant_delta')).toBe(true);
      expect(events.list(created.id)).toContainEqual(
        expect.objectContaining({ type: 'error', payload: expect.objectContaining({ message: expect.stringContaining('Retained event buffer exceeded') }) }),
      );
      expect(events.list(created.id)).toContainEqual(
        expect.objectContaining({ type: 'status', payload: { status: 'ERROR' } }),
      );
    } finally {
      events.append = originalAppend as EventsRepository['append'];
      overlapping.cancelPendingEventRetries(created.id);
      overlapping.release(0);
      await running;
    }
  });

  it('counts one oversized incoming delta against the aggregate retention budget', async () => {
    const overlapping = new OverlappingRunProvider(sessions, events);
    const created = sessions.create({ prompt: 'oversized retained delta', provider: 'overlapping' });
    const running = overlapping.run(created.id, created.prompt, { emit: () => {} });
    while (overlapping.contexts.length < 1) await Promise.resolve();
    const originalAppend = events.append.bind(events);
    events.append = (() => { throw new Error('disk full'); }) as EventsRepository['append'];
    try {
      expect(() => overlapping.emitFrom(0, 'x'.repeat(300 * 1024))).toThrow('Retained event buffer exceeded');
      expect(overlapping.released).toBe(1);
    } finally {
      events.append = originalAppend as EventsRepository['append'];
      overlapping.cancelPendingEventRetries(created.id);
      overlapping.release(0);
      await running;
    }
  });

  it('settles a RUNNING row after overflow recovery commits the retained ERROR status', async () => {
    const overlapping = new OverlappingRunProvider(sessions, events);
    const created = sessions.create({ prompt: 'overflow status recovery', provider: 'overlapping' });
    const running = overlapping.run(created.id, created.prompt, { emit: () => {} });
    while (overlapping.contexts.length < 1) await Promise.resolve();

    const originalAppend = events.append.bind(events);
    const originalUpdateStatus = sessions.updateStatus.bind(sessions);
    events.append = (() => { throw new Error('disk unavailable'); }) as EventsRepository['append'];
    sessions.updateStatus = (() => { throw new Error('status unavailable'); }) as SessionsRepository['updateStatus'];
    try {
      expect(() => overlapping.emitFrom(0, 'x'.repeat(300 * 1024))).toThrow(
        'Retained event buffer exceeded',
      );
      expect(sessions.findById(created.id)?.status).toBe('RUNNING');

      events.append = originalAppend as EventsRepository['append'];
      sessions.updateStatus = originalUpdateStatus as SessionsRepository['updateStatus'];
      overlapping.flushPendingEvents(created.id);

      expect(sessions.findById(created.id)?.status).toBe('ERROR');
      expect(events.list(created.id)).toContainEqual(
        expect.objectContaining({ type: 'status', payload: { status: 'ERROR' } }),
      );
    } finally {
      events.append = originalAppend as EventsRepository['append'];
      sessions.updateStatus = originalUpdateStatus as SessionsRepository['updateStatus'];
      overlapping.cancelPendingEventRetries(created.id);
      overlapping.release(0);
      await running;
    }
  });

  it('clears retained state when a live listener throws after the final event commits', async () => {
    provider.script = [
      { type: 'assistant_delta', payload: { delta: 'durable despite listener' } },
      { type: 'assistant_message', payload: { text: 'durable despite listener' } },
    ];
    const created = sessions.create({ prompt: 'listener failure', provider: 'scripted-tail' });
    const originalAppend = events.append.bind(events);
    let deltaFailures = 1;
    events.append = ((sessionId: string, type: string, payload: unknown) => {
      if (type === 'assistant_delta' && deltaFailures-- > 0) {
        throw new Error('force retained terminal queue');
      }
      return originalAppend(sessionId, type, payload);
    }) as EventsRepository['append'];

    try {
      await provider.run(created.id, created.prompt, {
        emit: (event) => {
          if (event.type === 'status' && (event.payload as { status?: string }).status === 'IDLE') {
            throw new Error('listener disconnected');
          }
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      events.append = originalAppend as EventsRepository['append'];
    }

    expect(events.list(created.id)).toContainEqual(
      expect.objectContaining({ type: 'status', payload: { status: 'IDLE' } }),
    );
    expect(provider.pendingEventSessionIds()).not.toContain(created.id);
  });

  it('does not let a disposed Mock callback overwrite the last accepted preview', async () => {
    const mock = new MockAgentProvider(sessions, events);
    const created = sessions.create({ prompt: 'preview fence', provider: 'mock' });
    const running = mock.run(created.id, created.prompt, { emit: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 45));

    mock.dispose(created.id);
    const previewAtDispose = sessions.findById(created.id)?.preview;
    await running;
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(previewAtDispose?.length).toBeGreaterThan(0);
    expect(sessions.findById(created.id)?.preview).toBe(previewAtDispose);
  });
});
