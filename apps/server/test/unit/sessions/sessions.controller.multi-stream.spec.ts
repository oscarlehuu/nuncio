import { SessionsController } from '../../../src/sessions/api/sessions.controller';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';

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

function ev(seq: number, type = 'assistant_delta'): SessionEvent {
  return { seq, type, payload: { delta: `d${seq}` }, createdAt: seq };
}

describe('SessionsController multi-session stream', () => {
  it('writes catch-up events tagged with their sessionId, honoring per-session since', () => {
    const listeners = new Map<string, (event: SessionEvent) => void>();
    const getEvents = jest.fn((id: string, since: number) =>
      id === 'aaa' ? [ev(3), ev(4)].filter((e) => e.seq > since) : [ev(1)].filter((e) => e.seq > since),
    );
    const subscribe = jest.fn((id: string, listener: (event: SessionEvent) => void) => {
      listeners.set(id, listener);
      return jest.fn();
    });
    const service = { get: (id: string) => ({ id }), getEvents, subscribe } as never;
    const controller = new SessionsController(service);
    const { res } = makeRes();

    controller.streamMulti('aaa:2,bbb:0', res as never);

    expect(getEvents).toHaveBeenCalledWith('aaa', 2);
    expect(getEvents).toHaveBeenCalledWith('bbb', 0);
    expect(res.write).toHaveBeenCalledWith(
      `data: ${JSON.stringify({ sessionId: 'aaa', ...ev(3) })}\n\n`,
    );
    expect(res.write).toHaveBeenCalledWith(
      `data: ${JSON.stringify({ sessionId: 'aaa', ...ev(4) })}\n\n`,
    );
    expect(res.write).toHaveBeenCalledWith(
      `data: ${JSON.stringify({ sessionId: 'bbb', ...ev(1) })}\n\n`,
    );

    // Live events fan in from every subscribed session, tagged the same way.
    listeners.get('bbb')?.(ev(2, 'status'));
    expect(res.write).toHaveBeenCalledWith(
      `data: ${JSON.stringify({ sessionId: 'bbb', ...ev(2, 'status') })}\n\n`,
    );
  });

  it('skips unknown sessions instead of failing the whole stream', () => {
    const getEvents = jest.fn(() => [ev(1)]);
    const subscribe = jest.fn(() => jest.fn());
    const service = {
      get: (id: string) => (id === 'known' ? { id } : null),
      getEvents,
      subscribe,
    } as never;
    const controller = new SessionsController(service);
    const { res } = makeRes();

    controller.streamMulti('ghost:0,known:0', res as never);

    expect(getEvents).toHaveBeenCalledTimes(1);
    expect(getEvents).toHaveBeenCalledWith('known', 0);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes every session on close', () => {
    const unsubs = [jest.fn(), jest.fn()];
    let call = 0;
    const service = {
      get: (id: string) => ({ id }),
      getEvents: () => [],
      subscribe: () => unsubs[call++],
    } as never;
    const controller = new SessionsController(service);
    const { res, onHandlers } = makeRes();

    controller.streamMulti('one:0,two:0', res as never);
    onHandlers['close']();

    expect(unsubs[0]).toHaveBeenCalled();
    expect(unsubs[1]).toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });
});
