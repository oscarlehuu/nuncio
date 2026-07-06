import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AgentRegistry } from './agents/agents.registry';
import { configureWebAppServing } from './web-static-assets';
import { TerminalService } from './terminal/terminal.service';
import { attachTerminalWebSocketServer } from './terminal/terminal.ws';
import { attachSessionsWebSocketServer } from './sessions/api/sessions.ws';
import { SessionsService } from './sessions/sessions.service';
import { AuthTokenService } from './auth/auth-token.service';
import { DevicesService } from './devices/devices.service';
import { TailscaleService } from './tailscale/tailscale.service';
import { HubService } from './hub/hub.service';
import { HubRegistryService } from './hub/hub-registry.service';
import { configureHubProxy } from './hub/hub.proxy';
import { attachHubWebSocketProxy } from './hub/hub.ws-proxy';

// The Cursor SDK under Bun emits stray NGHTTP2_FRAME_SIZE_ERROR / ERR_HTTP2_STREAM_ERROR
// events from its HTTP/2 streams (model discovery, Agent.create validation) that escape the
// provider's try/catch (they fire async on the stream 'error' event, not via the async
// iterator). Without a listener these become uncaught exceptions and crash the whole server.
// Swallow the known transient variety so the process stays up; let real bugs still crash.
function isTransientCursorHttp2Error(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  return (
    msg.includes('NGHTTP2_FRAME_SIZE_ERROR') ||
    msg.includes('Stream closed with error code') ||
    code === 'ERR_HTTP2_STREAM_ERROR'
  );
}

process.on('uncaughtException', (err) => {
  if (isTransientCursorHttp2Error(err)) {
    console.warn('[uncaughtException] swallowed transient Cursor HTTP/2 error:', err.message);
    return;
  }
  console.error('[uncaughtException] fatal:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  if (isTransientCursorHttp2Error(reason)) {
    console.warn('[unhandledRejection] swallowed transient Cursor HTTP/2 error:', String(reason));
    return;
  }
  console.error('[unhandledRejection] fatal:', reason);
  process.exit(1);
});

async function bootstrap() {
  // rawBody: true preserves the exact request bytes (app.rawBody) so inbound
  // forge webhooks can verify their HMAC signature over the unmodified payload.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.setGlobalPrefix('api');
  app.enableCors({ origin: true });
  // Raise the body limit so base64 image attachments fit (default is 100kb).
  // Use Nest's native body parser config rather than wiring Express parsers
  // directly so Nest's rawBody integration stays intact.
  app.useBodyParser('json', { limit: '25mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '25mb' });
  // Hub proxy runs before static serving so /m/<machine>/api/* is forwarded to
  // that machine; non-api /m/<machine>/ routes fall through to the SPA shell.
  // Client authorization happens at the hub edge — targets trust the hub by
  // whois, so the hub must not relay unauthenticated requests.
  configureHubProxy(
    app,
    app.get(HubService),
    app.get(HubRegistryService),
    app.get(AuthTokenService),
    app.get(TailscaleService),
  );
  configureWebAppServing(app);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    try {
      const registry = app.get(AgentRegistry);
      registry.cli().disposeAll();
    } catch {
      // App may not have finished booting.
    }

    try {
      await app.close();
    } catch {
      // App may not have finished booting.
    }

    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen(process.env.PORT ?? 3000);
  const authTokens = app.get(AuthTokenService);
  const devices = app.get(DevicesService);
  const httpServer = app.getHttpServer();
  // Hub WS proxy first: it only claims /m/<machine>/api/terminal and
  // /m/<machine>/api/sessions/ws upgrades and ignores the rest, so the local
  // handlers still own /api/terminal and /api/sessions/ws.
  attachHubWebSocketProxy(
    httpServer,
    app.get(HubService),
    app.get(HubRegistryService),
    authTokens,
    app.get(TailscaleService),
  );
  attachTerminalWebSocketServer(
    httpServer,
    app.get(TerminalService),
    authTokens,
    app.get(TailscaleService),
    devices,
  );
  attachSessionsWebSocketServer(
    httpServer,
    app.get(SessionsService),
    authTokens,
    app.get(TailscaleService),
    devices,
  );
  console.log(
    `[auth] loopback clients need no token; remote clients authenticate with: ${authTokens.token} (source: ${authTokens.source})`,
  );
}
bootstrap();
