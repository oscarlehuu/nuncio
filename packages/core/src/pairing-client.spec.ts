import { describe, expect, it, vi } from 'vitest';
import {
  claimPairing,
  deviceBearer,
  parsePairingQr,
  PairingClaimError,
  probeCandidates,
} from './pairing-client';

describe('parsePairingQr', () => {
  const ok = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ v: 1, code: 'abc-123_XYZ', urls: ['http://192.168.1.5:3000'], ...extra });

  it('parses a well-formed v1 payload', () => {
    expect(parsePairingQr(ok())).toEqual({ code: 'abc-123_XYZ', urls: ['http://192.168.1.5:3000'] });
  });

  it('rejects non-JSON and empty input', () => {
    expect(parsePairingQr('')).toBeNull();
    expect(parsePairingQr('   ')).toBeNull();
    expect(parsePairingQr('not json {')).toBeNull();
  });

  it('rejects non-object JSON (array, number, null)', () => {
    expect(parsePairingQr('[1,2]')).toBeNull();
    expect(parsePairingQr('42')).toBeNull();
    expect(parsePairingQr('null')).toBeNull();
  });

  it('rejects a wrong or missing version', () => {
    expect(parsePairingQr(JSON.stringify({ code: 'abc', urls: ['http://x'] }))).toBeNull();
    expect(parsePairingQr(ok({ v: 2 }))).toBeNull();
    expect(parsePairingQr(ok({ v: '1' }))).toBeNull();
  });

  it('rejects a missing, empty, or non-base64url code', () => {
    expect(parsePairingQr(JSON.stringify({ v: 1, urls: ['http://x'] }))).toBeNull();
    expect(parsePairingQr(ok({ code: '' }))).toBeNull();
    expect(parsePairingQr(ok({ code: 'has spaces' }))).toBeNull();
    expect(parsePairingQr(ok({ code: 'has.dot' }))).toBeNull();
  });

  it('rejects a missing, empty, oversized, or non-http url array', () => {
    expect(parsePairingQr(JSON.stringify({ v: 1, code: 'abc' }))).toBeNull();
    expect(parsePairingQr(ok({ urls: [] }))).toBeNull();
    expect(parsePairingQr(ok({ urls: 'http://x' }))).toBeNull();
    expect(parsePairingQr(ok({ urls: ['ftp://x'] }))).toBeNull();
    expect(parsePairingQr(ok({ urls: ['javascript:alert(1)'] }))).toBeNull();
    expect(parsePairingQr(ok({ urls: ['http://x', 42] }))).toBeNull();
    const nine = Array.from({ length: 9 }, (_, i) => `http://h${i}`);
    expect(parsePairingQr(ok({ urls: nine }))).toBeNull();
  });

  it('accepts exactly the max of 8 urls (boundary)', () => {
    const eight = Array.from({ length: 8 }, (_, i) => `http://h${i}`);
    expect(parsePairingQr(ok({ urls: eight }))?.urls).toHaveLength(8);
  });
});

describe('probeCandidates', () => {
  const okResponse = { ok: true, status: 200 } as Response;
  const badResponse = { ok: false, status: 500 } as Response;

  it('returns null for an empty list', async () => {
    expect(await probeCandidates([], { fetchImpl: async () => okResponse })).toBeNull();
  });

  it('returns the first-in-order healthy url', async () => {
    const seen: string[] = [];
    const winner = await probeCandidates(['http://a', 'http://b'], {
      fetchImpl: async (url) => {
        seen.push(url);
        return okResponse;
      },
    });
    expect(winner).toBe('http://a');
    // Both are probed in parallel (order priority, not first-response).
    expect(seen).toEqual(['http://a/api/health', 'http://b/api/health']);
  });

  it('prefers array order even when a later url answers first', async () => {
    // Real timers on purpose: the property under test only means something with
    // genuine timing — a fast later probe must not beat a slower earlier one.
    const winner = await probeCandidates(['http://slow', 'http://fast'], {
      fetchImpl: (url) =>
        new Promise((resolve) => {
          const delay = url.startsWith('http://slow') ? 40 : 5;
          setTimeout(() => resolve(okResponse), delay);
        }),
    });
    expect(winner).toBe('http://slow');
  });

  it('falls through to the next url when the first is unhealthy', async () => {
    const winner = await probeCandidates(['http://down', 'http://up'], {
      fetchImpl: async (url) => (url.startsWith('http://down') ? badResponse : okResponse),
    });
    expect(winner).toBe('http://up');
  });

  it('returns null when a candidate throws (connection refused)', async () => {
    const winner = await probeCandidates(['http://a'], {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(winner).toBeNull();
  });

  it('returns null when every candidate times out without hanging', async () => {
    vi.useFakeTimers();
    try {
      const promise = probeCandidates(['http://a', 'http://b'], {
        timeoutMs: 1000,
        // Never resolves on its own; only the abort timeout ends it.
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await promise).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves (never rejects) when fetchImpl throws synchronously', async () => {
    // A fetch impl that throws before returning a promise must not escape and
    // reject probeCandidates — the never-reject contract keeps the connection
    // manager from getting stuck 'connecting' on an unhandled rejection.
    await expect(
      probeCandidates(['http://a', 'http://b'], {
        fetchImpl: () => {
          throw new Error('boom');
        },
      }),
    ).resolves.toBeNull();
  });

  it('falls through a wedged candidate that ignores abort and never settles', async () => {
    // The early LAN candidate hangs forever AND ignores its AbortSignal — the
    // exact "LAN present but broken, fall back to Funnel" case. The healthy later
    // URL must still win within the timeout, not be stranded behind the hang.
    vi.useFakeTimers();
    try {
      const promise = probeCandidates(['http://wedged', 'http://healthy'], {
        timeoutMs: 1000,
        fetchImpl: (url) =>
          url.startsWith('http://healthy')
            ? Promise.resolve({ ok: true, status: 200 } as Response)
            : new Promise<Response>(() => {}), // never settles, ignores abort
      });
      await vi.advanceTimersByTimeAsync(1000); // wedged candidate's timeout elapses
      expect(await promise).toBe('http://healthy');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('claimPairing', () => {
  const claim = { deviceId: 'd1', deviceSecret: 's1', serverName: 'mac' };
  const jsonResponse = (status: number, body: unknown): Response =>
    ({
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    }) as Response;

  it('returns the credential on 200', async () => {
    const got = await claimPairing('http://a', { code: 'c' }, async () => jsonResponse(200, claim));
    expect(got).toEqual(claim);
  });

  it('maps 401 to an expired reason', async () => {
    await expect(
      claimPairing('http://a', { code: 'c' }, async () => jsonResponse(401, {})),
    ).rejects.toMatchObject({ reason: 'expired' });
  });

  it('maps 429 to a too-many reason', async () => {
    await expect(
      claimPairing('http://a', { code: 'c' }, async () => jsonResponse(429, {})),
    ).rejects.toMatchObject({ reason: 'too-many' });
  });

  it('maps other non-ok statuses to a generic error', async () => {
    await expect(
      claimPairing('http://a', { code: 'c' }, async () => jsonResponse(500, {})),
    ).rejects.toBeInstanceOf(PairingClaimError);
  });

  it('rejects a network failure', async () => {
    await expect(
      claimPairing('http://a', { code: 'c' }, async () => {
        throw new Error('offline');
      }),
    ).rejects.toMatchObject({ reason: 'error' });
  });

  it('rejects a 200 with a malformed body rather than saving half a credential', async () => {
    await expect(
      claimPairing('http://a', { code: 'c' }, async () => jsonResponse(200, { deviceId: 'd1' })),
    ).rejects.toBeInstanceOf(PairingClaimError);
  });

  it('treats a zero deadline as already expired without starting fetch', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, claim));

    await expect(
      claimPairing('http://a', { code: 'c' }, { timeoutMs: 0, fetchImpl }),
    ).rejects.toBeInstanceOf(PairingClaimError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('settles at the hard deadline when fetch ignores AbortSignal', async () => {
    vi.useFakeTimers();
    try {
      let outcome = 'pending';
      const rejection = claimPairing('http://a', { code: 'c' }, {
        timeoutMs: 1000,
        fetchImpl: () => new Promise<Response>(() => {}),
      }).then(
        () => null,
        (error) => {
          outcome = 'rejected';
          return error;
        },
      );

      await vi.advanceTimersByTimeAsync(999);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(await rejection).toMatchObject({
        name: 'PairingClaimError',
        reason: 'error',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the hard deadline to a response body that never settles', async () => {
    vi.useFakeTimers();
    try {
      const rejection = claimPairing('http://a', { code: 'c' }, {
        timeoutMs: 1000,
        fetchImpl: async () =>
          ({
            status: 200,
            ok: true,
            json: () => new Promise<never>(() => {}),
          }) as unknown as Response,
      }).then(
        () => null,
        (error) => error,
      );

      await vi.advanceTimersByTimeAsync(1000);
      expect(await rejection).toBeInstanceOf(PairingClaimError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports caller cancellation even when fetch ignores the signal', async () => {
    const caller = new AbortController();
    let forwardedSignal: AbortSignal | null | undefined;
    const promise = claimPairing('http://a', { code: 'c' }, {
      signal: caller.signal,
      timeoutMs: 60_000,
      fetchImpl: (_url, init) => {
        forwardedSignal = init?.signal;
        return new Promise<Response>(() => {});
      },
    });

    await Promise.resolve();
    caller.abort();

    await expect(promise).rejects.toMatchObject({
      name: 'PairingClaimError',
      reason: 'error',
    });
    expect(forwardedSignal?.aborted).toBe(true);
  });
});

describe('deviceBearer', () => {
  it('formats the nd1 device bearer value', () => {
    expect(deviceBearer('d1', 's1')).toBe('nd1.d1.s1');
  });
});
