import { describe, expect, it, jest } from 'bun:test';
import { EventEmitter } from 'node:events';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { SessionsController } from '../../../src/sessions/api/sessions.controller';
import type { SessionDto, SessionEvent } from '../../../src/sessions/domain/sessions.types';

function makeSession(over: Partial<SessionDto> = {}): SessionDto {
  return {
    id: 's1',
    title: 't',
    status: 'IDLE',
    provider: 'cursor',
    model: null,
    modelOptions: null,
    mode: null,
    workspace: null,
    prompt: 'p',
    preview: null,
    projectPath: null,
    baseBranch: null,
    worktreePath: null,
    branch: null,
    providerThreadId: null,
    providerActiveTurnId: null,
    providerState: null,
    cursorBackend: null,
    cursorChatId: null,
    supportsInteraction: false,
    supportsInterrupt: false,
    supportsSteerWhileRunning: false,
    supportsImages: false,
    pendingInput: false,
    parentSessionId: null,
    originTaskId: null,
    priorSessionId: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const SAMPLE_EVENTS: SessionEvent[] = [
  { seq: 1, type: 'status', payload: { status: 'RUNNING' }, createdAt: 1 },
  { seq: 2, type: 'user_message', payload: { text: 'hi' }, createdAt: 2 },
];

function makeRes() {
  const emitter = new EventEmitter();
  const onHandlers: Record<string, (...args: unknown[]) => void> = {};
  const res = {
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn((_value: string) => true),
    on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      onHandlers[event] = cb;
      emitter.on(event, cb);
      return res;
    }),
    off: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      emitter.off(event, cb);
      return res;
    }),
    end: jest.fn(() => {
      res.writableEnded = true;
      return res;
    }),
    emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
    writableEnded: false,
    destroyed: false,
  };
  return { res, onHandlers };
}

describe('SessionsController', () => {
  it('lineage delegates to the service and returns ancestors and children', () => {
    const result = {
      ancestors: [{ id: 'p1', title: 'parent', status: 'IDLE' as const, provider: 'cursor' }],
      children: [{ id: 'c1', title: 'child', status: 'DONE' as never, provider: 'cursor' }],
    };
    const lineage = jest.fn(() => result);
    const controller = new SessionsController({ lineage } as never);
    expect(controller.lineage('s1')).toEqual(result);
    expect(lineage).toHaveBeenCalledWith('s1');
  });

  it('lineage propagates NotFound from the service', () => {
    const lineage = jest.fn(() => {
      throw new NotFoundException('Session not found');
    });
    const controller = new SessionsController({ lineage } as never);
    expect(() => controller.lineage('missing')).toThrow(NotFoundException);
  });

  it('stream sets SSE headers, writes existing events as data: lines, and subscribes', () => {
    const unsubscribe = jest.fn();
    const subscribe = jest.fn(() => unsubscribe);
    const getEvents = jest.fn(() => SAMPLE_EVENTS);
    const service = { get: () => makeSession(), getEvents, subscribe } as never;
    const controller = new SessionsController(service);
    const { res, onHandlers } = makeRes();

    controller.stream('s1', undefined, res as never);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(res.flushHeaders).toHaveBeenCalled();
    expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify(SAMPLE_EVENTS[0])}\n\n`);
    expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify(SAMPLE_EVENTS[1])}\n\n`);
    expect(getEvents).toHaveBeenCalledWith('s1', 0);
    expect(subscribe).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(res.on).toHaveBeenCalledWith('close', expect.any(Function));

    onHandlers['close']();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('stream respects the since cursor', () => {
    const subscribe = jest.fn(() => jest.fn());
    const getEvents = jest.fn(() => SAMPLE_EVENTS);
    const service = { get: () => makeSession(), getEvents, subscribe } as never;
    const controller = new SessionsController(service);
    const { res, onHandlers } = makeRes();

    controller.stream('s1', '2', res as never);

    expect(getEvents).toHaveBeenCalledWith('s1', 2);
    onHandlers['close']();
  });

  it('stream falls back to cursor 0 for a non-numeric since', () => {
    const subscribe = jest.fn(() => jest.fn());
    const getEvents = jest.fn(() => SAMPLE_EVENTS);
    const service = { get: () => makeSession(), getEvents, subscribe } as never;
    const controller = new SessionsController(service);
    const { res, onHandlers } = makeRes();

    controller.stream('s1', 'abc', res as never);

    expect(getEvents).toHaveBeenCalledWith('s1', 0);
    onHandlers['close']();
  });

  it('stream pauses replay and live writes until the response drains', () => {
    let live: ((event: SessionEvent) => void) | undefined;
    const unsubscribe = jest.fn();
    const subscribe = jest.fn((_id: string, callback: (event: SessionEvent) => void) => {
      live = callback;
      return unsubscribe;
    });
    const service = {
      get: () => makeSession(),
      getEvents: () => SAMPLE_EVENTS,
      subscribe,
    } as never;
    const controller = new SessionsController(service);
    const { res } = makeRes();
    let writeCall = 0;
    res.write.mockImplementation(() => {
      writeCall += 1;
      return writeCall !== 1;
    });

    controller.stream('s1', undefined, res as never);
    expect(res.write).toHaveBeenCalledTimes(1);

    const liveEvent: SessionEvent = {
      seq: 3,
      type: 'assistant_delta',
      payload: { delta: 'live' },
      createdAt: 3,
    };
    live?.(liveEvent);
    expect(res.write).toHaveBeenCalledTimes(1);

    res.emit('drain');
    expect(res.write.mock.calls.map(([value]) => value)).toEqual([
      `data: ${JSON.stringify(SAMPLE_EVENTS[0])}\n\n`,
      `data: ${JSON.stringify(SAMPLE_EVENTS[1])}\n\n`,
      `data: ${JSON.stringify(liveEvent)}\n\n`,
    ]);
    res.emit('close');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  for (const terminalEvent of ['close', 'error'] as const) {
    it(`stream cleans up exactly once when the response emits ${terminalEvent} while blocked`, () => {
      let live: ((event: SessionEvent) => void) | undefined;
      const unsubscribe = jest.fn();
      const subscribe = jest.fn((_id: string, callback: (event: SessionEvent) => void) => {
        live = callback;
        return unsubscribe;
      });
      const service = {
        get: () => makeSession(),
        getEvents: () => [SAMPLE_EVENTS[0]],
        subscribe,
      } as never;
      const controller = new SessionsController(service);
      const { res } = makeRes();
      res.write.mockImplementation(() => false);

      controller.stream('s1', undefined, res as never);
      let thrown: unknown;
      try {
        res.emit(terminalEvent, terminalEvent === 'error' ? new Error('socket failed') : undefined);
        if (terminalEvent === 'close') res.emit('close');
      } catch (error) {
        thrown = error;
      }
      const writesAtCleanup = res.write.mock.calls.length;
      live?.({
        seq: 2,
        type: 'assistant_delta',
        payload: { delta: 'late' },
        createdAt: 2,
      });

      expect(thrown).toBeUndefined();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(res.end).not.toHaveBeenCalled();
      expect(res.write).toHaveBeenCalledTimes(writesAtCleanup);
    });
  }

  it('stops live writes and unsubscribes when the response is already destroyed', () => {
    let live: ((event: SessionEvent) => void) | undefined;
    const unsubscribe = jest.fn();
    const service = {
      get: () => makeSession(),
      getEvents: () => [],
      subscribe: (_id: string, callback: (event: SessionEvent) => void) => {
        live = callback;
        return unsubscribe;
      },
    } as never;
    const controller = new SessionsController(service);
    const { res } = makeRes();

    controller.stream('s1', undefined, res as never);
    res.destroyed = true;
    live?.({ seq: 1, type: 'assistant_delta', payload: { delta: 'late' }, createdAt: 1 });

    expect(res.write).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('cleans up a synchronously delivered subscription overflow exactly once', () => {
    const unsubscribe = jest.fn();
    const service = {
      get: () => makeSession(),
      getEvents: () => [],
      subscribe: (_id: string, callback: (event: SessionEvent) => void) => {
        callback({ seq: 1, type: 'assistant_delta', payload: { delta: 'blocked' }, createdAt: 1 });
        callback({
          seq: 2,
          type: 'assistant_delta',
          payload: { delta: 'x'.repeat(1_100_000) },
          createdAt: 2,
        });
        return unsubscribe;
      },
    } as never;
    const controller = new SessionsController(service);
    const { res } = makeRes();
    res.write.mockImplementation(() => false);

    controller.stream('s1', undefined, res as never);
    res.emit('close');

    expect(res.write).toHaveBeenCalledTimes(1);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('applies the same backpressure policy to heartbeat writes', () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let heartbeat: (() => void) | undefined;
    globalThis.setInterval = jest.fn((callback: TimerHandler) => {
      heartbeat = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    const clearIntervalMock = jest.fn(() => undefined);
    globalThis.clearInterval = clearIntervalMock as typeof clearInterval;
    const unsubscribe = jest.fn();
    const service = {
      get: () => makeSession(),
      getEvents: () => [],
      subscribe: () => unsubscribe,
    } as never;
    const controller = new SessionsController(service);
    const { res } = makeRes();
    let writeCall = 0;
    res.write.mockImplementation(() => {
      writeCall += 1;
      return writeCall !== 1;
    });

    try {
      controller.stream('s1', undefined, res as never);
      heartbeat?.();
      heartbeat?.();
      expect(res.write).toHaveBeenCalledTimes(1);

      res.emit('drain');
      expect(res.write.mock.calls.map(([value]) => value)).toEqual([': ping\n\n', ': ping\n\n']);
      res.emit('close');
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(clearIntervalMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it('keeps an exactly-full pending queue and disconnects on the next frame', () => {
    let live: ((event: SessionEvent) => void) | undefined;
    const unsubscribe = jest.fn();
    const service = {
      get: () => makeSession(),
      getEvents: () => [],
      subscribe: (_id: string, callback: (event: SessionEvent) => void) => {
        live = callback;
        return unsubscribe;
      },
    } as never;
    const controller = new SessionsController(service);
    const { res } = makeRes();
    res.write.mockImplementation(() => false);

    controller.stream('s1', undefined, res as never);
    live?.({ seq: 1, type: 'assistant_delta', payload: { delta: 'blocked' }, createdAt: 1 });
    const exactEvent = {
      seq: 2,
      type: 'assistant_delta',
      payload: { delta: '' },
      createdAt: 2,
    } satisfies SessionEvent;
    const emptyFrame = `data: ${JSON.stringify(exactEvent)}\n\n`;
    exactEvent.payload.delta = 'x'.repeat(1_000_000 - Buffer.byteLength(emptyFrame));
    expect(Buffer.byteLength(`data: ${JSON.stringify(exactEvent)}\n\n`)).toBe(1_000_000);

    live?.(exactEvent);
    expect(res.end).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();

    live?.({ seq: 3, type: 'assistant_delta', payload: { delta: 'one-past' }, createdAt: 3 });
    const observed = {
      endCalls: res.end.mock.calls.length,
      unsubscribeCalls: unsubscribe.mock.calls.length,
      writeCalls: res.write.mock.calls.length,
    };
    res.emit('close');

    expect(observed).toEqual({ endCalls: 1, unsubscribeCalls: 1, writeCalls: 1 });
  });

  it('contains a live SSE write failure and cleans up the subscription', () => {
    let live: ((event: SessionEvent) => void) | undefined;
    const unsubscribe = jest.fn();
    const service = {
      get: () => makeSession(),
      getEvents: () => [],
      subscribe: (_id: string, callback: (event: SessionEvent) => void) => {
        live = callback;
        return unsubscribe;
      },
    } as never;
    const controller = new SessionsController(service);
    const { res } = makeRes();
    res.write.mockImplementation(() => {
      throw new Error('write failed');
    });

    controller.stream('s1', undefined, res as never);
    let thrown: unknown;
    try {
      live?.({ seq: 1, type: 'assistant_delta', payload: { delta: 'x' }, createdAt: 1 });
    } catch (error) {
      thrown = error;
    }
    const observed = {
      endCalls: res.end.mock.calls.length,
      unsubscribeCalls: unsubscribe.mock.calls.length,
    };
    res.emit('close');

    expect(thrown).toBeUndefined();
    expect(observed).toEqual({ endCalls: 1, unsubscribeCalls: 1 });
  });

  it('create returns an error object when the prompt is blank', () => {
    const service = {} as never;
    const controller = new SessionsController(service);

    expect(controller.create({ prompt: '   ' })).toEqual({ error: 'prompt is required' });
  });

  it('create forwards workspace, worktree, model options, and attachments to the service', () => {
    const create = jest.fn(() => makeSession());
    const controller = new SessionsController({ create } as never);

    controller.create({
      prompt: '  build it  ',
      provider: 'codex',
      model: 'codex:gpt-5.5',
      modelOptions: { reasoningEffort: 'high', fast: true },
      workspace: '/code/nuncio',
      projectPath: '/code/nuncio',
      baseBranch: 'main',
      useWorktree: true,
      attachments: [{ kind: 'image', mimeType: 'image/png', data: 'abc' }],
    });

    expect(create).toHaveBeenCalledWith({
      prompt: 'build it',
      provider: 'codex',
      model: 'codex:gpt-5.5',
      modelOptions: { reasoningEffort: 'high', fast: true },
      workspace: '/code/nuncio',
      projectPath: '/code/nuncio',
      baseBranch: 'main',
      useWorktree: true,
      attachments: [{ kind: 'image', mimeType: 'image/png', data: 'abc' }],
    });
  });

  it('create forwards a valid contextBrief to the service', () => {
    const create = jest.fn(() => makeSession());
    const controller = new SessionsController({ create } as never);

    controller.create({ prompt: 'go', contextBrief: { goal: 'ship the thing' } } as never);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ contextBrief: expect.objectContaining({ goal: 'ship the thing' }) }),
    );
  });

  it('create rejects an invalid contextBrief (missing goal) with 400', () => {
    const controller = new SessionsController({ create: jest.fn() } as never);
    expect(() =>
      controller.create({ prompt: 'go', contextBrief: { constraints: ['x'] } } as never),
    ).toThrow(BadRequestException);
  });

  it('steer forwards message, forceResume, and attachments to the service', () => {
    const steer = jest.fn(() => makeSession());
    const controller = new SessionsController({ steer } as never);

    controller.steer('s1', {
      message: 'continue',
      forceResume: true,
      attachments: [{ kind: 'image', mimeType: 'image/jpeg', data: 'xyz' }],
    });

    expect(steer).toHaveBeenCalledWith('s1', 'continue', true, [
      { kind: 'image', mimeType: 'image/jpeg', data: 'xyz' },
    ]);
  });

  it('interrupt delegates to sessions.interrupt', async () => {
    const interrupt = jest.fn(async () => undefined);
    const controller = new SessionsController({ interrupt } as never);

    await expect(controller.interrupt('s1')).resolves.toBeUndefined();
    expect(interrupt).toHaveBeenCalledWith('s1');
  });

  it('setModel delegates to sessions.setSessionModel', () => {
    const setSessionModel = jest.fn(() => makeSession({ model: 'pi:model-2' }));
    const controller = new SessionsController({ setSessionModel } as never);

    expect(controller.setModel('s1', { model: 'pi:model-2', options: { thinkingLevel: 'high' } })).toMatchObject({
      model: 'pi:model-2',
    });
    expect(setSessionModel).toHaveBeenCalledWith('s1', 'pi:model-2', { thinkingLevel: 'high' });
  });

  it('get throws NotFoundException when the session is missing', () => {
    const service = { get: () => null } as never;
    const controller = new SessionsController(service);

    expect(() => controller.get('nope')).toThrow(NotFoundException);
  });

  it('captures evidence for an existing session and returns media refs', async () => {
    const result = {
      beforeRef: { id: '0123456789abcdef0123456789abcdef', mimeType: 'image/png' as const },
      route: '/app', viewport: { w: 1440, h: 900 }, workspaceHead: 'abc123',
    };
    const capture = jest.fn(async () => result);
    const appendOrchestrationEvent = jest.fn();
    const current = makeSession({ worktreePath: '/repo' });
    const requirePublicMutableSession = jest.fn(() => current);
    const controller = new SessionsController(
      { requirePublicMutableSession, appendOrchestrationEvent } as never,
      { capture } as never,
    );

    await expect(controller.captureEvidence('s1', {
      url: 'http://localhost:5173', route: '/app', phase: 'before',
    })).resolves.toEqual(result);
    expect(capture).toHaveBeenCalledWith(current, {
      url: 'http://localhost:5173', route: '/app', phase: 'before',
    });
    expect(appendOrchestrationEvent).toHaveBeenCalledWith('s1', 'evidence_captured', result);
    expect(requirePublicMutableSession).toHaveBeenCalledWith('s1');
  });

  it('captures simulator evidence without a URL and appends the shared event', async () => {
    const result = {
      afterRef: { id: '0123456789abcdef0123456789abcdef', mimeType: 'image/png' as const },
      route: 'simulator://booted', viewport: { w: 1179, h: 2556 }, workspaceHead: 'abc123',
    };
    const capture = jest.fn(async () => result);
    const appendOrchestrationEvent = jest.fn();
    const current = makeSession({ worktreePath: '/repo' });
    const controller = new SessionsController(
      { requirePublicMutableSession: () => current, appendOrchestrationEvent } as never,
      { capture } as never,
    );

    await expect(controller.captureEvidence('s1', {
      target: 'simulator', phase: 'after',
    })).resolves.toEqual(result);
    expect(capture).toHaveBeenCalledWith(current, { target: 'simulator', phase: 'after' });
    expect(appendOrchestrationEvent).toHaveBeenCalledWith('s1', 'evidence_captured', result);
  });

  it('appends no event when simulator capability is unavailable', async () => {
    const appendOrchestrationEvent = jest.fn();
    const controller = new SessionsController(
      { requirePublicMutableSession: () => makeSession(), appendOrchestrationEvent } as never,
      { capture: async () => { throw new ServiceUnavailableException('xcrun unavailable'); } } as never,
    );
    await expect(controller.captureEvidence('s1', { target: 'simulator', phase: 'before' }))
      .rejects.toThrow('xcrun unavailable');
    expect(appendOrchestrationEvent).not.toHaveBeenCalled();
  });

  it('returns unavailable browser capture without appending an evidence event', async () => {
    const unavailable = { unavailable: true as const, reason: 'Browser capture unavailable' };
    const appendOrchestrationEvent = jest.fn();
    const controller = new SessionsController(
      { requirePublicMutableSession: () => makeSession(), appendOrchestrationEvent } as never,
      { capture: async () => unavailable } as never,
    );

    await expect(controller.captureEvidence('s1', {
      url: 'http://localhost:5173', phase: 'before',
    })).resolves.toEqual(unavailable);
    expect(appendOrchestrationEvent).not.toHaveBeenCalled();
  });

  it('rejects evidence capture for a missing session', async () => {
    const controller = new SessionsController(
      { requirePublicMutableSession: () => { throw new NotFoundException('Session not found'); } } as never,
      { capture: jest.fn() } as never,
    );
    await expect(controller.captureEvidence('missing', {
      url: 'http://localhost:5173', phase: 'after',
    })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects Crew-owned evidence mutation before capture or append', async () => {
    const capture = jest.fn();
    const appendOrchestrationEvent = jest.fn();
    const controller = new SessionsController({
      requirePublicMutableSession: () => {
        throw new BadRequestException('Crew-owned sessions are read-only outside Crew controls');
      },
      appendOrchestrationEvent,
    } as never, { capture } as never);
    await expect(controller.captureEvidence('crew-member', {
      url: 'http://localhost:5173', phase: 'before',
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(capture).not.toHaveBeenCalled();
    expect(appendOrchestrationEvent).not.toHaveBeenCalled();
  });

  it('rejects a missing evidence body with BadRequestException', async () => {
    const controller = new SessionsController({
      requirePublicMutableSession: () => makeSession(),
    } as never, { capture: jest.fn() } as never);
    await expect(controller.captureEvidence('s1', null as never))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid simulator evidence phase before capture', async () => {
    const capture = jest.fn();
    const controller = new SessionsController({
      requirePublicMutableSession: () => makeSession(),
    } as never, { capture } as never);
    await expect(controller.captureEvidence('s1', {
      target: 'simulator', phase: 'during' as never,
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(capture).not.toHaveBeenCalled();
  });

  it('forgets known evidence targets after archive succeeds', () => {
    const archive = jest.fn(() => makeSession({ status: 'ARCHIVED' }));
    const forget = jest.fn();
    const controller = new SessionsController({ archive } as never, { forget } as never);
    expect(controller.archive('s1')).toMatchObject({ status: 'ARCHIVED' });
    expect(forget).toHaveBeenCalledWith('s1');
  });

  it('keeps known evidence targets when archive fails', () => {
    const archive = jest.fn(() => { throw new BadRequestException('cannot archive'); });
    const forget = jest.fn();
    const controller = new SessionsController({ archive } as never, { forget } as never);
    expect(() => controller.archive('s1')).toThrow(BadRequestException);
    expect(forget).not.toHaveBeenCalled();
  });

  it('events throws NotFoundException when the session is missing', () => {
    const service = { get: () => null } as never;
    const controller = new SessionsController(service);

    expect(() => controller.events('nope', undefined, undefined, undefined, undefined)).toThrow(
      NotFoundException,
    );
  });

  it('events forwards since, limit, tail, and before to the service', () => {
    const getEvents = jest.fn(() => SAMPLE_EVENTS);
    const service = { get: () => makeSession(), getEvents } as never;
    const controller = new SessionsController(service);

    controller.events('s1', '3', '50', undefined, undefined);
    expect(getEvents).toHaveBeenCalledWith('s1', 3, { limit: 50 });

    controller.events('s1', undefined, undefined, '30', undefined);
    expect(getEvents).toHaveBeenCalledWith('s1', 0, { tail: 30 });

    controller.events('s1', undefined, '20', undefined, '90');
    expect(getEvents).toHaveBeenCalledWith('s1', 0, { limit: 20, before: 90 });
  });

  it('events ignores non-numeric limit, tail, and before', () => {
    const getEvents = jest.fn(() => SAMPLE_EVENTS);
    const service = { get: () => makeSession(), getEvents } as never;
    const controller = new SessionsController(service);

    controller.events('s1', undefined, 'abc', 'nan', 'huh');
    expect(getEvents).toHaveBeenCalledWith('s1', 0, {});
  });

  it('restore delegates to sessions.restore', () => {
    const restore = jest.fn(() => makeSession({ id: 's1', status: 'IDLE' }));
    const service = { restore } as never;
    const controller = new SessionsController(service);

    expect(controller.restore('s1')).toMatchObject({ id: 's1', status: 'IDLE' });
    expect(restore).toHaveBeenCalledWith('s1');
  });

  it('delete delegates to sessions.delete and acknowledges only after completion', async () => {
    let finishDelete: () => void = () => undefined;
    const del = jest.fn(() => new Promise<void>((resolve) => { finishDelete = resolve; }));
    const service = { delete: del } as never;
    const controller = new SessionsController(service);

    let result: unknown = 'pending';
    const deleting = controller.delete('s1').then((value) => { result = value; });
    await Promise.resolve();
    expect(result).toBe('pending');
    finishDelete();
    await deleting;
    expect(result).toEqual({ ok: true });
    expect(del).toHaveBeenCalledWith('s1');
  });

  it('forgets a captured preview target after session deletion', async () => {
    const forget = jest.fn();
    const controller = new SessionsController(
      { delete: jest.fn(async () => undefined) } as never,
      { forget } as never,
    );
    await controller.delete('s1');
    expect(forget).toHaveBeenCalledWith('s1');
  });

  it('respondProviderRequest delegates to sessions.respondProviderRequest', () => {
    const respondProviderRequest = jest.fn(() => ({ requestId: 'req-1', decision: 'approve' }));
    const service = { respondProviderRequest } as never;
    const controller = new SessionsController(service);

    expect(controller.respondProviderRequest('s1', 'req-1', { decision: 'approve' })).toEqual({
      requestId: 'req-1',
      decision: 'approve',
    });
    expect(respondProviderRequest).toHaveBeenCalledWith('s1', 'req-1', 'approve');
  });
});
