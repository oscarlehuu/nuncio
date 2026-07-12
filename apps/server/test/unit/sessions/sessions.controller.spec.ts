import { BadRequestException, NotFoundException } from '@nestjs/common';
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
  const onHandlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    res: {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
        onHandlers[event] = cb;
      }),
      end: jest.fn(),
    },
    onHandlers,
  };
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
    const subscribe = jest.fn(() => jest.fn());
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
    expect(res.end).toHaveBeenCalled();
  });

  it('stream respects the since cursor', () => {
    const subscribe = jest.fn(() => jest.fn());
    const getEvents = jest.fn(() => SAMPLE_EVENTS);
    const service = { get: () => makeSession(), getEvents, subscribe } as never;
    const controller = new SessionsController(service);
    const { res } = makeRes();

    controller.stream('s1', '2', res as never);

    expect(getEvents).toHaveBeenCalledWith('s1', 2);
  });

  it('stream falls back to cursor 0 for a non-numeric since', () => {
    const subscribe = jest.fn(() => jest.fn());
    const getEvents = jest.fn(() => SAMPLE_EVENTS);
    const service = { get: () => makeSession(), getEvents, subscribe } as never;
    const controller = new SessionsController(service);
    const { res } = makeRes();

    controller.stream('s1', 'abc', res as never);

    expect(getEvents).toHaveBeenCalledWith('s1', 0);
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
    const controller = new SessionsController(
      { get: () => current, appendOrchestrationEvent } as never,
      { capture } as never,
    );

    await expect(controller.captureEvidence('s1', {
      url: 'http://localhost:5173', route: '/app', phase: 'before',
    })).resolves.toEqual(result);
    expect(capture).toHaveBeenCalledWith(current, {
      url: 'http://localhost:5173', route: '/app', phase: 'before',
    });
    expect(appendOrchestrationEvent).toHaveBeenCalledWith('s1', 'evidence_captured', result);
  });

  it('rejects evidence capture for a missing session', async () => {
    const controller = new SessionsController(
      { get: () => null } as never,
      { capture: jest.fn() } as never,
    );
    await expect(controller.captureEvidence('missing', {
      url: 'http://localhost:5173', phase: 'after',
    })).rejects.toBeInstanceOf(NotFoundException);
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
