import { NotFoundException } from '@nestjs/common';
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
    cursorBackend: null,
    cursorChatId: null,
    supportsInteraction: false,
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

  it('get throws NotFoundException when the session is missing', () => {
    const service = { get: () => null } as never;
    const controller = new SessionsController(service);

    expect(() => controller.get('nope')).toThrow(NotFoundException);
  });

  it('events throws NotFoundException when the session is missing', () => {
    const service = { get: () => null } as never;
    const controller = new SessionsController(service);

    expect(() => controller.events('nope', undefined)).toThrow(NotFoundException);
  });

  it('restore delegates to sessions.restore', () => {
    const restore = jest.fn(() => makeSession({ id: 's1', status: 'IDLE' }));
    const service = { restore } as never;
    const controller = new SessionsController(service);

    expect(controller.restore('s1')).toMatchObject({ id: 's1', status: 'IDLE' });
    expect(restore).toHaveBeenCalledWith('s1');
  });

  it('delete delegates to sessions.delete', () => {
    const del = jest.fn();
    const service = { delete: del } as never;
    const controller = new SessionsController(service);

    controller.delete('s1');
    expect(del).toHaveBeenCalledWith('s1');
  });
});
