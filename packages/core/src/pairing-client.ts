/**
 * Shared client for the QR pairing handshake (parse → probe → claim). Lives in
 * core so the mobile app, the web app, and tests all pin the exact same QR
 * payload contract and error mapping. No platform APIs here — `fetch` is
 * injected so the whole flow runs under a fake fetch in unit tests.
 */

/** A parsed, validated QR payload. */
export interface PairingQr {
  code: string;
  urls: string[];
}

/** Successful `POST /api/pairing/claim` body — the device credential, returned once. */
export interface PairingClaim {
  deviceId: string;
  deviceSecret: string;
  serverName: string;
}

/** Distinguishes UX-relevant claim failures from a generic error. */
export type ClaimErrorReason = 'expired' | 'too-many' | 'error';

export class PairingClaimError extends Error {
  readonly reason: ClaimErrorReason;

  constructor(reason: ClaimErrorReason, message: string) {
    super(message);
    this.name = 'PairingClaimError';
    this.reason = reason;
  }
}

export type PairingFetch = (input: string, init?: RequestInit) => Promise<Response>;

// A malicious or corrupt QR must not make us probe an unbounded list; the
// server never emits more than a handful (LAN ips + MagicDNS + Funnel).
const MAX_URLS = 8;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DEFAULT_PROBE_TIMEOUT_MS = 3000;

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Parses a scanned QR string into `{code, urls}`, or null if it is not a
 * well-formed v1 pairing payload. Rejects on: non-JSON, non-object, `v !== 1`,
 * an empty/non-base64url code, a missing/empty/oversized URL array, or any
 * entry that is not an http(s) URL. The `v` gate is the forward-compat seam —
 * a future v2 QR parses to null here rather than being half-understood.
 */
export function parsePairingQr(text: string): PairingQr | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 1) return null;
  if (typeof obj.code !== 'string' || !BASE64URL.test(obj.code)) return null;
  if (!Array.isArray(obj.urls) || obj.urls.length === 0 || obj.urls.length > MAX_URLS) {
    return null;
  }
  if (!obj.urls.every(isHttpUrl)) return null;
  return { code: obj.code, urls: obj.urls };
}

interface ProbeOptions {
  fetchImpl?: PairingFetch;
  timeoutMs?: number;
}

/**
 * Returns the first reachable base URL **in array order** — array order encodes
 * the LAN → MagicDNS → Funnel preference, so a healthy LAN endpoint always wins
 * over a healthy Funnel one even if Funnel answers first. All candidates are
 * probed in parallel (each with its own abort-on-timeout `GET /api/health`); the
 * winner is the earliest-in-order that returns ok. Resolves to null if none is
 * healthy within `timeoutMs`. Never rejects — a dead network is a null, not a
 * throw.
 */
export async function probeCandidates(urls: string[], options: ProbeOptions = {}): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (urls.length === 0) return null;

  // Each slot resolves to true/false. We must honour ORDER, not arrival: a fast
  // late-in-order winner must not beat a slower earlier one. So we await slots
  // left-to-right, but every probe is already in flight (started below), so the
  // total wait is bounded by the slowest single probe, not their sum.
  const results = urls.map((url) => probeOne(url, fetchImpl, timeoutMs));
  for (let i = 0; i < results.length; i++) {
    if (await results[i]) return urls[i];
  }
  return null;
}

function probeOne(url: string, fetchImpl: PairingFetch, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  // The health fetch resolves to res.ok, or false on any failure. Calling
  // fetchImpl inside a `.then` turns a SYNCHRONOUS throw (an impl that throws
  // before returning a promise) into a rejected promise, so the `.catch` below
  // maps it to false — probeCandidates must never reject, only resolve to null.
  const health = Promise.resolve()
    .then(() => fetchImpl(`${url}/api/health`, { signal: controller.signal }))
    .then((res) => res.ok)
    .catch(() => false);

  // Race against a hard timeout that resolves false. Aborting the fetch is
  // best-effort — a fetch that ignores AbortSignal (or never settles) must NOT
  // block returning: otherwise one wedged early LAN candidate would strand a
  // healthy later Funnel URL, since callers await candidates in array order.
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, timeoutMs);
    void health.then((ok) => {
      clearTimeout(timer);
      resolve(ok);
    });
  });
}

export interface ClaimRequest {
  code: string;
  deviceName?: string;
  platform?: string;
}

export interface ClaimPairingOptions {
  fetchImpl?: PairingFetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_CLAIM_TIMEOUT_MS = 10_000;

function normalizeClaimOptions(input?: PairingFetch | ClaimPairingOptions): Required<
  Pick<ClaimPairingOptions, 'fetchImpl' | 'timeoutMs'>
> & Pick<ClaimPairingOptions, 'signal'> {
  if (typeof input === 'function') {
    return { fetchImpl: input, timeoutMs: DEFAULT_CLAIM_TIMEOUT_MS };
  }
  const timeoutMs = input?.timeoutMs;
  return {
    fetchImpl: input?.fetchImpl ?? ((request, init) => globalThis.fetch(request, init)),
    timeoutMs:
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 0
        ? timeoutMs
        : DEFAULT_CLAIM_TIMEOUT_MS,
    signal: input?.signal,
  };
}

async function performClaim(
  baseUrl: string,
  body: ClaimRequest,
  fetchImpl: PairingFetch,
  signal: AbortSignal,
): Promise<PairingClaim> {
  const res = await fetchImpl(`${baseUrl}/api/pairing/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 401) {
    throw new PairingClaimError('expired', 'This pairing code has expired. Scan a fresh QR code.');
  }
  if (res.status === 429) {
    throw new PairingClaimError('too-many', 'Too many attempts. Wait a moment and try again.');
  }
  if (!res.ok) {
    throw new PairingClaimError('error', `Pairing failed (${res.status}).`);
  }
  const parsed = (await res.json().catch(() => null)) as Partial<PairingClaim> | null;
  if (
    !parsed ||
    typeof parsed.deviceId !== 'string' ||
    typeof parsed.deviceSecret !== 'string' ||
    typeof parsed.serverName !== 'string'
  ) {
    throw new PairingClaimError('error', 'The desktop returned an unexpected response.');
  }
  return { deviceId: parsed.deviceId, deviceSecret: parsed.deviceSecret, serverName: parsed.serverName };
}

/**
 * Exchanges a pairing code for a device credential on the chosen base URL.
 * The whole exchange, including response-body parsing, has a hard deadline;
 * aborting is best-effort, so even a fetch that ignores AbortSignal cannot hang
 * the caller. Passing a fetch function as the third argument remains supported.
 */
export async function claimPairing(
  baseUrl: string,
  body: ClaimRequest,
  fetchOrOptions?: PairingFetch | ClaimPairingOptions,
): Promise<PairingClaim> {
  const options = normalizeClaimOptions(fetchOrOptions);
  if (options.signal?.aborted) {
    throw new PairingClaimError('error', 'Pairing was cancelled.');
  }
  if (options.timeoutMs === 0) {
    throw new PairingClaimError('error', 'Pairing timed out.');
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onCallerAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    onCallerAbort = () => {
      controller.abort();
      reject(new PairingClaimError('error', 'Pairing was cancelled.'));
    };
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });
    timeout = setTimeout(() => {
      controller.abort();
      reject(new PairingClaimError('error', 'Pairing timed out.'));
    }, options.timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => performClaim(baseUrl, body, options.fetchImpl, controller.signal)),
      deadline,
    ]);
  } catch (error) {
    if (error instanceof PairingClaimError) throw error;
    throw new PairingClaimError('error', 'Could not reach the desktop.');
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onCallerAbort) options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/** Builds the device bearer value `nd1.<deviceId>.<deviceSecret>` for REST + WS. */
export function deviceBearer(deviceId: string, deviceSecret: string): string {
  return `nd1.${deviceId}.${deviceSecret}`;
}
