import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AgentRegistry } from './agents/agents.registry';

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
  // Use Nest's native body parser config rather than importing `express`
  // directly — `express` is only a transitive dep and is not resolvable as a
  // bare specifier under Bun's isolated module store.
  app.useBodyParser('json', { limit: '25mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '25mb' });

  const shutdown = () => {
    try {
      const registry = app.get(AgentRegistry);
      registry.cli().disposeAll();
    } catch {
      // App may not have finished booting.
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
