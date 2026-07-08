import { Controller, Get, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureWebAppServing } from '../../src/web-static-assets';

@Controller('health')
class StaticAssetsTestHealthController {
  @Get()
  health() {
    return { status: 'ok', service: 'test-api' };
  }
}

@Module({ controllers: [StaticAssetsTestHealthController] })
class StaticAssetsTestModule {}

async function createApp(webDistPath: string): Promise<NestExpressApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [StaticAssetsTestModule],
  }).compile();

  const app = moduleFixture.createNestApplication<NestExpressApplication>({ rawBody: true });
  app.setGlobalPrefix('api');
  configureWebAppServing(app, webDistPath);
  await app.init();
  return app;
}

describe('web static asset serving', () => {
  let tempDir: string;
  let app: NestExpressApplication | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createFixtureDist(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'nuncio-web-dist-'));
    const distPath = join(tempDir, 'dist');
    mkdirSync(join(distPath, 'assets'), { recursive: true });
    mkdirSync(join(distPath, 'api'), { recursive: true });
    writeFileSync(
      join(distPath, 'index.html'),
      '<!doctype html><html><head><title>Nuncio</title></head><body><div id="root">SPA shell</div></body></html>',
    );
    writeFileSync(join(distPath, 'assets', 'app.js'), 'console.log("nuncio");\n');
    writeFileSync(join(distPath, 'api', 'health'), '<!doctype html><p>static shadow</p>');
    return distPath;
  }

  it('serves index.html as text/html for non-api app routes when dist exists', async () => {
    app = await createApp(createFixtureDist());

    const res = await request(app.getHttpServer()).get('/sessions/deep-link');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('SPA shell');
  });

  it('serves built asset files from the dist root', async () => {
    app = await createApp(createFixtureDist());

    const res = await request(app.getHttpServer()).get('/assets/app.js');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.text).toContain('console.log("nuncio")');
  });

  it('keeps /api routes on the Nest JSON handlers even if dist contains matching files', async () => {
    app = await createApp(createFixtureDist());

    const res = await request(app.getHttpServer()).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ status: 'ok', service: 'test-api' });
  });

  it('does not fall back to HTML for missing /api routes when dist exists', async () => {
    app = await createApp(createFixtureDist());

    const res = await request(app.getHttpServer()).get('/api/missing-route');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.text).not.toContain('<!doctype html>');
    expect(res.body.message).toBe('Cannot GET /api/missing-route');
  });

  it('serves the SPA even when dist lives under a dot-segment directory', async () => {
    // Git worktrees (.claude/worktrees/...) and Linux data dirs (~/.local/share)
    // put dist under a dotted path segment; express dotfile rules must apply to
    // the path relative to the dist root, never to the root's own location.
    tempDir = mkdtempSync(join(tmpdir(), 'nuncio-web-dist-dotted-'));
    const distPath = join(tempDir, '.hidden', 'dist');
    mkdirSync(distPath, { recursive: true });
    writeFileSync(
      join(distPath, 'index.html'),
      '<!doctype html><html><body><div id="root">SPA shell</div></body></html>',
    );
    app = await createApp(distPath);

    const res = await request(app.getHttpServer()).get('/session/deep-link');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('SPA shell');
  });

  it('does nothing when dist is absent so the app still boots and /api works', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nuncio-web-dist-absent-'));
    app = await createApp(join(tempDir, 'missing-dist'));

    const res = await request(app.getHttpServer()).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'test-api' });
  });
});
