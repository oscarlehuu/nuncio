import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  canonicalizeHubTargetPath,
  parseHubPath,
  resolveMachineTarget,
} from './hub-routing';
import { streamHubResponse } from './hub-response-stream';
import { HubService } from './hub.service';
import { HubRegistryService } from './hub-registry.service';
import type { TokenValidator } from '../auth/auth-request';
import { isAuthorizedUpgrade, type RemoteTrust } from '../auth/upgrade-auth';

const DEFAULT_UPSTREAM_RESPONSE_TIMEOUT_MS = 30_000;

/** Public target routes mirror the target daemon's own @Public routes. */
export function isPublicHubTargetPath(targetPath: string): boolean {
  const canonical = canonicalizeHubTargetPath(targetPath);
  if (!canonical) return false;
  const pathOnly = canonical.split('?')[0];
  return (
    pathOnly === '/api/auth/login' ||
    pathOnly === '/api/health' ||
    pathOnly.startsWith('/api/webhooks/')
  );
}

export function isAuthorizedHubRequest(
  req: { headers?: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } },
  targetPath: string,
  authTokens?: TokenValidator,
  trust?: RemoteTrust,
): Promise<boolean> {
  const canonical = canonicalizeHubTargetPath(targetPath);
  if (!canonical) return Promise.resolve(false);
  if (isPublicHubTargetPath(canonical)) return Promise.resolve(true);
  return isAuthorizedUpgrade(
    { headers: req.headers, socket: { remoteAddress: req.socket?.remoteAddress } },
    authTokens,
    trust,
  );
}

// Hop-by-hop headers must not be forwarded (fetch manages framing itself).
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);

export interface ProxyRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Buffer | undefined;
}

export interface HubProxyOptions {
  upstreamResponseTimeoutMs?: number;
}

export function buildProxyRequest(
  req: Pick<Request, 'method' | 'headers'> & { rawBody?: Buffer; body?: unknown },
  targetOrigin: string,
  targetPath: string,
): ProxyRequest {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (typeof value === 'string') headers[key] = value;
    else if (Array.isArray(value)) headers[key] = value.join(', ');
  }

  const method = req.method ?? 'GET';
  let body: string | Buffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    if (req.rawBody && req.rawBody.length > 0) body = req.rawBody;
    else if (req.body !== undefined && req.body !== null) body = JSON.stringify(req.body);
  }
  return { url: `${targetOrigin}${targetPath}`, method, headers, body };
}

type UpstreamResponse = {
  status: number;
  headers: { forEach: (cb: (value: string, key: string) => void) => void };
  body: ReadableStream<Uint8Array> | null;
};

type HeaderOutcome =
  | { type: 'response'; response: UpstreamResponse }
  | { type: 'error'; error: unknown }
  | { type: 'timeout' }
  | { type: 'downstream-closed' };

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // Cancellation is cleanup; the primary request outcome is already known.
  }
}

/** Install the machine-prefixed HTTP/SSE proxy before local routes/static UI. */
export function configureHubProxy(
  app: NestExpressApplication,
  hub: HubService,
  registry: HubRegistryService,
  authTokens?: TokenValidator,
  trust?: RemoteTrust,
  options?: HubProxyOptions,
): void {
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (!hub.enabled()) return next();

    const parsed = parseHubPath(req.originalUrl);
    if (!parsed) {
      if (req.originalUrl.startsWith('/m/')) {
        res.status(400).json({ message: 'Malformed hub target path' });
        return;
      }
      return next();
    }

    const targetPathname = parsed.targetPath.split('?')[0];
    if (targetPathname !== '/api' && !targetPathname.startsWith('/api/')) return next();

    let authorized = false;
    try {
      authorized = await isAuthorizedHubRequest(req, parsed.targetPath, authTokens, trust);
    } catch {
      authorized = false;
    }
    if (!authorized) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    let target: string | null;
    try {
      target = resolveMachineTarget(parsed.machine, await registry.registryMap());
    } catch {
      target = null;
    }
    if (!target) {
      res.status(404).json({ message: `Unknown machine '${parsed.machine}'` });
      return;
    }

    const proxyReq = buildProxyRequest(req, target, parsed.targetPath);
    const controller = new AbortController();
    let abortIssued = false;
    let downstreamClosed = false;
    let resolveDownstreamClosed: ((outcome: HeaderOutcome) => void) | undefined;
    const downstreamClosedOutcome = new Promise<HeaderOutcome>((resolve) => {
      resolveDownstreamClosed = resolve;
    });
    const abortUpstream = () => {
      if (abortIssued) return;
      abortIssued = true;
      controller.abort();
    };
    const onDownstreamTerminated = () => {
      if (downstreamClosed) return;
      downstreamClosed = true;
      abortUpstream();
      resolveDownstreamClosed?.({ type: 'downstream-closed' });
    };
    res.on('close', onDownstreamTerminated);
    res.on('error', onDownstreamTerminated);

    const timeoutMs =
      options?.upstreamResponseTimeoutMs && options.upstreamResponseTimeoutMs > 0
        ? options.upstreamResponseTimeoutMs
        : DEFAULT_UPSTREAM_RESPONSE_TIMEOUT_MS;
    const fetchOutcome: Promise<HeaderOutcome> = Promise.resolve()
      .then(() => fetch(proxyReq.url, {
        method: proxyReq.method,
        headers: proxyReq.headers,
        body: proxyReq.body as BodyInit | undefined,
        redirect: 'manual',
        signal: controller.signal,
      }))
      .then(
        (response) => ({ type: 'response', response: response as unknown as UpstreamResponse }),
        (error) => ({ type: 'error', error }),
      );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutOutcome = new Promise<HeaderOutcome>((resolve) => {
      timeout = setTimeout(() => {
        abortUpstream();
        resolve({ type: 'timeout' });
      }, timeoutMs);
    });

    try {
      const outcome = await Promise.race([fetchOutcome, timeoutOutcome, downstreamClosedOutcome]);
      if (timeout) clearTimeout(timeout);

      if (outcome.type !== 'response') {
        void fetchOutcome.then((late) => (
          late.type === 'response' ? cancelBody(late.response.body) : undefined
        ));
        if (outcome.type === 'timeout' && !downstreamClosed && !res.headersSent) {
          res.status(504).json({ message: `Hub target '${parsed.machine}' timed out` });
        } else if (outcome.type === 'error' && !downstreamClosed && !res.headersSent) {
          const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
          res.status(502).json({ message: `Hub could not reach '${parsed.machine}': ${detail}` });
        }
        return;
      }

      const upstream = outcome.response;
      if (downstreamClosed) {
        await cancelBody(upstream.body);
        return;
      }

      try {
        res.status(upstream.status);
        upstream.headers.forEach((value, key) => {
          if (!HOP_BY_HOP.has(key.toLowerCase())) res.setHeader(key, value);
        });
      } catch {
        await cancelBody(upstream.body);
        return;
      }

      if (!upstream.body) {
        if (!downstreamClosed && !res.writableEnded && !res.destroyed) res.end();
        return;
      }

      let reader: ReadableStreamDefaultReader<Uint8Array>;
      try {
        reader = upstream.body.getReader();
      } catch {
        if (!downstreamClosed && !res.writableEnded && !res.destroyed) {
          try {
            res.destroy();
          } catch {
            // Reader acquisition failed; never turn the unusable response into clean EOF.
          }
        }
        await cancelBody(upstream.body);
        return;
      }
      await streamHubResponse(reader, res);
    } finally {
      if (timeout) clearTimeout(timeout);
      res.off('close', onDownstreamTerminated);
      res.off('error', onDownstreamTerminated);
    }
  });
}
