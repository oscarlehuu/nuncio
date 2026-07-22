import { afterEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureHubProxy } from '../../../src/hub/hub.proxy';
import type { HubService } from '../../../src/hub/hub.service';
import type { HubRegistryService } from '../../../src/hub/hub-registry.service';
import type { TokenValidator } from '../../../src/auth/auth-request';

interface ProxyOptions {
  upstreamResponseTimeoutMs?: number;
}

type ProxyMiddleware = (req: Request, res: Response, next: NextFunction) => Promise<void>;
type ConfigureWithOptions = (
  app: NestExpressApplication,
  hub: HubService,
  registry: HubRegistryService,
  authTokens?: TokenValidator,
  trust?: undefined,
  options?: ProxyOptions,
) => void;

const configureWithOptions = configureHubProxy as unknown as ConfigureWithOptions;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

class ControlledResponse extends EventEmitter {
  readonly headers = new Map<string, string>();
  readonly writes: Buffer[] = [];
  readonly statusCalls: number[] = [];
  readonly jsonCalls: unknown[] = [];
  writeResults: boolean[] = [];
  writeError: Error | null = null;
  destroyError: Error | null = null;
  destroyEmitsClose = false;
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  destroyCalls = 0;
  endCalls = 0;

  status(code: number): this {
    this.statusCalls.push(code);
    return this;
  }

  json(value: unknown): this {
    this.jsonCalls.push(value);
    this.headersSent = true;
    this.writableEnded = true;
    return this;
  }

  setHeader(key: string, value: string): this {
    this.headers.set(key, value);
    return this;
  }

  write(value: Uint8Array): boolean {
    if (this.writeError) throw this.writeError;
    this.headersSent = true;
    this.writes.push(Buffer.from(value));
    return this.writeResults.shift() ?? true;
  }

  destroy(): this {
    this.destroyCalls += 1;
    if (this.destroyError) throw this.destroyError;
    this.destroyed = true;
    if (this.destroyEmitsClose) this.emit('close');
    return this;
  }

  end(): this {
    this.endCalls += 1;
    this.writableEnded = true;
    return this;
  }
}

function makeMiddleware(options: ProxyOptions = {}): ProxyMiddleware {
  let middleware: ProxyMiddleware | undefined;
  const app = {
    use: (candidate: ProxyMiddleware) => {
      middleware = candidate;
    },
  } as unknown as NestExpressApplication;
  configureWithOptions(
    app,
    { enabled: () => true } as HubService,
    {
      registryMap: async () => new Map([['machine', 'http://target.test:3000']]),
    } as unknown as HubRegistryService,
    { isValidToken: () => false },
    undefined,
    options,
  );
  if (!middleware) throw new Error('hub middleware was not installed');
  return middleware;
}

function request(originalUrl: string, remoteAddress = '192.168.1.20'): Request {
  return {
    originalUrl,
    method: 'GET',
    headers: {},
    socket: { remoteAddress },
  } as unknown as Request;
}

function upstream(reader: {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: () => Promise<void>;
  releaseLock?: () => void;
}, status = 200) {
  return {
    status,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: { getReader: () => reader },
  } as unknown as globalThis.Response;
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition did not settle');
}

describe('hub HTTP target-path boundary', () => {
  for (const [label, targetPath] of [
    ['raw dot segments', '/api/webhooks/../sessions'],
    ['encoded dot segments', '/api/webhooks/%2e%2e/sessions'],
    ['mixed encoded dot segments', '/api/webhooks/.%2E/sessions'],
  ] as const) {
    it(`authorizes the canonical protected route for ${label}`, async () => {
      let fetched = false;
      globalThis.fetch = (async () => {
        fetched = true;
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch;
      const res = new ControlledResponse();

      await makeMiddleware()(request(`/m/machine${targetPath}`), res as unknown as Response, () => undefined);

      expect(res.statusCalls).toEqual([401]);
      expect(fetched).toBe(false);
    });
  }

  it('forwards the canonical path, not its traversal spelling, for an authorized request', async () => {
    let forwardedUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      forwardedUrl = String(input);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const res = new ControlledResponse();

    await makeMiddleware()(
      request('/m/machine/api/webhooks/%2e%2e/sessions?since=7', '127.0.0.1'),
      res as unknown as Response,
      () => undefined,
    );

    expect(forwardedUrl).toBe('http://target.test:3000/api/sessions?since=7');
    expect(res.statusCalls).toEqual([204]);
  });

  for (const malformed of [
    '/m/%/api/sessions',
    '/m/%GG/api/sessions',
    '/m/machine/api/%',
    '/m/machine/api/%2',
    '/m/machine/api/%GG',
  ]) {
    it(`rejects malformed percent encoding without throwing or forwarding: ${malformed}`, async () => {
      let fetched = false;
      globalThis.fetch = (async () => {
        fetched = true;
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch;
      const res = new ControlledResponse();

      await expect(
        makeMiddleware()(request(malformed), res as unknown as Response, () => undefined),
      ).resolves.toBeUndefined();
      expect(fetched).toBe(false);
      expect(res.statusCalls).toEqual([400]);
    });
  }

  it('returns 502 when the upstream fetch rejects before headers', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const res = new ControlledResponse();

    await makeMiddleware()(
      request('/m/machine/api/sessions', '127.0.0.1'),
      res as unknown as Response,
      () => undefined,
    );

    expect(res.statusCalls).toEqual([502]);
    expect(res.jsonCalls).toEqual([{
      message: "Hub could not reach 'machine': connection refused",
    }]);
  });

  it('preserves legitimate machine-prefixed public routing and query strings', async () => {
    let forwardedUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      forwardedUrl = String(input);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const res = new ControlledResponse();

    await makeMiddleware()(
      request('/m/machine/api/health?probe=ready'),
      res as unknown as Response,
      () => undefined,
    );

    expect(forwardedUrl).toBe('http://target.test:3000/api/health?probe=ready');
    expect(res.statusCalls).toEqual([204]);
    expect(res.endCalls).toBe(1);
  });
});

describe('hub HTTP response streaming', () => {
  it('stops reading while res.write reports backpressure and resumes on drain', async () => {
    let index = 0;
    const values = [
      { done: false, value: new Uint8Array([1]) },
      { done: false, value: new Uint8Array([2]) },
      { done: true },
    ];
    const reader = {
      read: mock(async () => values[index++] as { done: boolean; value?: Uint8Array }),
      cancel: mock(async () => undefined),
      releaseLock: mock(),
    };
    globalThis.fetch = (async () => upstream(reader)) as unknown as typeof fetch;
    const res = new ControlledResponse();
    res.writeResults = [false, true];

    const handling = makeMiddleware()(
      request('/m/machine/api/sessions', '127.0.0.1'),
      res as unknown as Response,
      () => undefined,
    );
    await waitFor(() => res.writes.length > 0);

    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(res.writes).toEqual([Buffer.from([1])]);

    res.emit('drain');
    await handling;
    expect(reader.read).toHaveBeenCalledTimes(3);
    expect(res.writes).toEqual([Buffer.from([1]), Buffer.from([2])]);
    expect(res.endCalls).toBe(1);
    expect(res.destroyCalls).toBe(0);
    expect(reader.cancel).not.toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('cancels once and does not end again when the downstream closes while blocked', async () => {
    let finishRead: ((value: { done: boolean }) => void) | undefined;
    let calls = 0;
    const reader = {
      read: mock(() => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ done: false, value: new Uint8Array([1]) });
        return new Promise<{ done: boolean }>((resolve) => {
          finishRead = resolve;
        });
      }),
      cancel: mock(async () => {
        finishRead?.({ done: true });
      }),
      releaseLock: mock(),
    };
    globalThis.fetch = (async () => upstream(reader)) as unknown as typeof fetch;
    const res = new ControlledResponse();
    res.writeResults = [false];

    const handling = makeMiddleware()(
      request('/m/machine/api/sessions', '127.0.0.1'),
      res as unknown as Response,
      () => undefined,
    );
    await waitFor(() => res.writes.length > 0);
    res.emit('close');
    res.emit('close');
    await settleMicrotasks();
    const observed = {
      cancelCalls: reader.cancel.mock.calls.length,
      endCalls: res.endCalls,
    };
    finishRead?.({ done: true });
    await handling;

    expect(observed).toEqual({ cancelCalls: 1, endCalls: 0 });
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(res.endCalls).toBe(0);
  });

  it('settles close cleanup even when a pending read ignores failed cancellation', async () => {
    let finishRead: ((value: { done: boolean }) => void) | undefined;
    let readPending = true;
    const reader = {
      read: mock(() => new Promise<{ done: boolean }>((resolve) => {
        finishRead = resolve;
      })),
      cancel: mock(async () => {
        throw new Error('cancel failed');
      }),
      releaseLock: mock(() => {
        if (readPending) throw new Error('read still pending');
      }),
    };
    globalThis.fetch = (async () => upstream(reader)) as unknown as typeof fetch;
    const res = new ControlledResponse();
    let settled = false;
    const handling = makeMiddleware()(
      request('/m/machine/api/sessions', '127.0.0.1'),
      res as unknown as Response,
      () => undefined,
    ).then(() => {
      settled = true;
    });
    await waitFor(() => reader.read.mock.calls.length === 1);

    res.emit('close');
    await Bun.sleep(10);
    const observed = { settled, cancelCalls: reader.cancel.mock.calls.length };
    readPending = false;
    finishRead?.({ done: true });
    await handling;
    await settleMicrotasks();

    expect(observed).toEqual({ settled: true, cancelCalls: 1 });
    expect(reader.releaseLock).toHaveBeenCalledTimes(2);
    expect(res.endCalls).toBe(0);
  });

  it('cancels the upstream body and destroys the response when reader acquisition throws', async () => {
    const cancel = mock(async () => undefined);
    globalThis.fetch = (async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: {
        cancel,
        getReader: () => {
          throw new Error('reader acquisition failed');
        },
      },
    }) as unknown as globalThis.Response) as unknown as typeof fetch;
    const res = new ControlledResponse();

    await makeMiddleware()(
      request('/m/machine/api/sessions', '127.0.0.1'),
      res as unknown as Response,
      () => undefined,
    );

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(res.destroyCalls).toBe(1);
    expect(res.endCalls).toBe(0);
  });

  it('destroys instead of ending when the first upstream read rejects', async () => {
    const reader = {
      read: mock(async () => {
        throw new Error('upstream read failed');
      }),
      cancel: mock(async () => undefined),
      releaseLock: mock(),
    };
    globalThis.fetch = (async () => upstream(reader)) as unknown as typeof fetch;
    const res = new ControlledResponse();

    await makeMiddleware()(
      request('/m/machine/api/sessions', '127.0.0.1'),
      res as unknown as Response,
      () => undefined,
    );

    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(res.destroyCalls).toBe(1);
    expect(res.endCalls).toBe(0);
  });

  it('destroys after a partial body when a later upstream read rejects', async () => {
    let calls = 0;
    const reader = {
      read: mock(async () => {
        calls += 1;
        if (calls === 1) return { done: false, value: new Uint8Array([1, 2, 3]) };
        throw new Error('upstream read failed after partial body');
      }),
      cancel: mock(async () => undefined),
      releaseLock: mock(),
    };
    globalThis.fetch = (async () => upstream(reader)) as unknown as typeof fetch;
    const res = new ControlledResponse();

    await makeMiddleware()(
      request('/m/machine/api/sessions', '127.0.0.1'),
      res as unknown as Response,
      () => undefined,
    );

    expect(res.writes).toEqual([Buffer.from([1, 2, 3])]);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(res.destroyCalls).toBe(1);
    expect(res.endCalls).toBe(0);
  });

  it('does not duplicate cleanup when failure destruction emits close re-entrantly', async () => {
    const reader = {
      read: mock(async () => {
        throw new Error('upstream read failed');
      }),
      cancel: mock(async () => undefined),
      releaseLock: mock(),
    };
    globalThis.fetch = (async () => upstream(reader)) as unknown as typeof fetch;
    const res = new ControlledResponse();
    res.destroyEmitsClose = true;

    await makeMiddleware()(
      request('/m/machine/api/sessions', '127.0.0.1'),
      res as unknown as Response,
      () => undefined,
    );

    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(res.destroyCalls).toBe(1);
    expect(res.endCalls).toBe(0);
  });

  it('contains destroy failure without ending the truncated response', async () => {
    const reader = {
      read: mock(async () => {
        throw new Error('upstream read failed');
      }),
      cancel: mock(async () => undefined),
      releaseLock: mock(),
    };
    globalThis.fetch = (async () => upstream(reader)) as unknown as typeof fetch;
    const res = new ControlledResponse();
    res.destroyError = new Error('destroy failed');

    await expect(
      makeMiddleware()(
        request('/m/machine/api/sessions', '127.0.0.1'),
        res as unknown as Response,
        () => undefined,
      ),
    ).resolves.toBeUndefined();

    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(res.destroyCalls).toBe(1);
    expect(res.endCalls).toBe(0);
  });

  it('does not destroy or end again when downstream close wins a pending read rejection', async () => {
    let rejectRead: ((error: Error) => void) | undefined;
    let readPending = true;
    const reader = {
      read: mock(() => new Promise<{ done: boolean }>((_, reject) => {
        rejectRead = reject;
      })),
      cancel: mock(async () => undefined),
      releaseLock: mock(() => {
        if (readPending) throw new Error('read still pending');
      }),
    };
    globalThis.fetch = (async () => upstream(reader)) as unknown as typeof fetch;
    const res = new ControlledResponse();

    const handling = makeMiddleware()(
      request('/m/machine/api/sessions', '127.0.0.1'),
      res as unknown as Response,
      () => undefined,
    );
    await waitFor(() => reader.read.mock.calls.length === 1);
    res.emit('close');
    res.emit('close');
    await handling;

    readPending = false;
    rejectRead?.(new Error('late upstream read failure'));
    await waitFor(() => reader.releaseLock.mock.calls.length === 2);

    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(res.destroyCalls).toBe(0);
    expect(res.endCalls).toBe(0);
  });

  it('destroys after write failure without double-ending the response', async () => {
    const reader = {
      read: mock(async () => ({ done: false, value: new Uint8Array([1]) })),
      cancel: mock(async () => undefined),
      releaseLock: mock(),
    };
    globalThis.fetch = (async () => upstream(reader)) as unknown as typeof fetch;
    const res = new ControlledResponse();
    res.writeError = new Error('downstream write failed');

    await expect(
      makeMiddleware()(
        request('/m/machine/api/sessions', '127.0.0.1'),
        res as unknown as Response,
        () => undefined,
      ),
    ).resolves.toBeUndefined();

    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(res.destroyCalls).toBe(1);
    expect(res.endCalls).toBe(0);
  });

  it('contains cancel rejection during close cleanup', async () => {
    let finishRead: ((value: { done: boolean }) => void) | undefined;
    let calls = 0;
    const reader = {
      read: mock(() => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ done: false, value: new Uint8Array([1]) });
        return new Promise<{ done: boolean }>((resolve) => {
          finishRead = resolve;
        });
      }),
      cancel: mock(async () => {
        throw new Error('cancel failed');
      }),
      releaseLock: mock(),
    };
    globalThis.fetch = (async () => upstream(reader)) as unknown as typeof fetch;
    const res = new ControlledResponse();
    res.writeResults = [false];

    const handling = makeMiddleware()(
      request('/m/machine/api/sessions', '127.0.0.1'),
      res as unknown as Response,
      () => undefined,
    );
    await waitFor(() => res.writes.length > 0);
    res.emit('close');
    await settleMicrotasks();
    finishRead?.({ done: true });

    await expect(handling).resolves.toBeUndefined();
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(res.endCalls).toBe(0);
  });
});

describe('hub upstream response-header deadline', () => {
  it('returns 504 and aborts when the connected target never sends response headers', async () => {
    let rejectFetch: ((error: Error) => void) | undefined;
    let signal: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      return new Promise<globalThis.Response>((_, reject) => {
        rejectFetch = reject;
      });
    }) as unknown as typeof fetch;
    const res = new ControlledResponse();
    let settled = false;
    const handling = makeMiddleware({ upstreamResponseTimeoutMs: 20 })(
      request('/m/machine/api/sessions', '127.0.0.1'),
      res as unknown as Response,
      () => undefined,
    ).then(() => {
      settled = true;
    });

    await Bun.sleep(50);
    const observed = {
      settled,
      aborted: signal?.aborted ?? false,
      statuses: [...res.statusCalls],
    };
    rejectFetch?.(new Error('late fetch rejection'));
    await handling;

    expect(observed).toEqual({ settled: true, aborted: true, statuses: [504] });
    expect(res.jsonCalls).toEqual([{ message: "Hub target 'machine' timed out" }]);
  });

  it('cancels a response body that arrives after the header deadline already settled', async () => {
    let resolveFetch: ((response: globalThis.Response) => void) | undefined;
    const cancel = mock(async () => undefined);
    globalThis.fetch = (() => new Promise<globalThis.Response>((resolve) => {
      resolveFetch = resolve;
    })) as unknown as typeof fetch;
    const res = new ControlledResponse();

    const handling = makeMiddleware({ upstreamResponseTimeoutMs: 10 })(
      request('/m/machine/api/sessions', '127.0.0.1'),
      res as unknown as Response,
      () => undefined,
    );
    await handling;
    resolveFetch?.({
      status: 200,
      headers: new Headers(),
      body: { cancel },
    } as unknown as globalThis.Response);
    await waitFor(() => cancel.mock.calls.length === 1);

    expect(res.statusCalls).toEqual([504]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not treat a non-positive timeout override as an immediate deadline', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const res = new ControlledResponse();

    await makeMiddleware({ upstreamResponseTimeoutMs: 0 })(
      request('/m/machine/api/health', '127.0.0.1'),
      res as unknown as Response,
      () => undefined,
    );

    expect(res.statusCalls).toEqual([204]);
    expect(res.endCalls).toBe(1);
  });

  it('settles and aborts exactly when the client closes before headers arrive', async () => {
    let rejectFetch: ((error: Error) => void) | undefined;
    let signal: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      return new Promise<globalThis.Response>((_, reject) => {
        rejectFetch = reject;
      });
    }) as unknown as typeof fetch;
    const res = new ControlledResponse();
    let settled = false;
    const handling = makeMiddleware({ upstreamResponseTimeoutMs: 1_000 })(
      request('/m/machine/api/sessions', '127.0.0.1'),
      res as unknown as Response,
      () => undefined,
    ).then(() => {
      settled = true;
    });
    await settleMicrotasks();

    res.emit('close');
    res.emit('close');
    await settleMicrotasks();
    const observed = { settled, aborted: signal?.aborted ?? false };
    rejectFetch?.(new Error('late close rejection'));
    await handling;

    expect(observed).toEqual({ settled: true, aborted: true });
    expect(res.statusCalls).toEqual([]);
    expect(res.endCalls).toBe(0);
  });
});
