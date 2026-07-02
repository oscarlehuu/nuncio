import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseHubPath, resolveMachineTarget } from './hub-routing';
import { HubService } from './hub.service';
import { HubRegistryService } from './hub-registry.service';

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
    if (req.rawBody && req.rawBody.length > 0) {
      body = req.rawBody;
    } else if (req.body !== undefined && req.body !== null) {
      body = JSON.stringify(req.body);
    }
  }

  return { url: `${targetOrigin}${targetPath}`, method, headers, body };
}

/**
 * Hub HTTP proxy. For /m/<machine>/... requests (when hub mode is on), resolves
 * the machine against the auto-discovered registry (SSRF guard) and streams the
 * response from that machine's own nuncio — including SSE, which must not be
 * buffered. Hub→target runs over the tailnet, so the target trusts the hub by
 * whois identity. Non-hub paths and disabled hub mode fall straight through.
 */
export function configureHubProxy(
  app: NestExpressApplication,
  hub: HubService,
  registry: HubRegistryService,
): void {
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (!hub.enabled()) return next();
    const parsed = parseHubPath(req.originalUrl);
    if (!parsed) return next();

    // Only /api is proxied; /m/<machine>/<app-route> is served the SPA shell
    // (the shell boots, computes its base path, and calls /m/<machine>/api/*).
    if (parsed.targetPath !== '/api' && !parsed.targetPath.startsWith('/api/')) {
      return next();
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
    res.on('close', () => controller.abort());

    let upstream: Response & { body?: unknown };
    try {
      upstream = (await fetch(proxyReq.url, {
        method: proxyReq.method,
        headers: proxyReq.headers,
        body: proxyReq.body as BodyInit | undefined,
        redirect: 'manual',
        signal: controller.signal,
      })) as unknown as Response & { body?: unknown };
    } catch (error) {
      if (!res.headersSent) {
        res.status(502).json({
          message: `Hub could not reach '${parsed.machine}': ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    const upstreamAny = upstream as unknown as {
      status: number;
      headers: { forEach: (cb: (v: string, k: string) => void) => void };
      body: ReadableStream<Uint8Array> | null;
    };
    res.status(upstreamAny.status);
    upstreamAny.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) res.setHeader(key, value);
    });

    if (!upstreamAny.body) {
      res.end();
      return;
    }

    // Stream chunks as they arrive so SSE stays live (no buffering).
    const reader = upstreamAny.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
      }
    } catch {
      // Client disconnected or upstream aborted; end the response.
    } finally {
      res.end();
    }
  });
}
