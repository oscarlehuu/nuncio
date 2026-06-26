import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppModule } from './app.module';

describe('Nuncio API', () => {
  let app: INestApplication;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-test-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    process.env.NUNCIO_FORCE_MOCK = '1';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.NUNCIO_FORCE_MOCK;
  });

  it('GET /api/health returns ok', async () => {
    const res = await request(app.getHttpServer()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('POST /api/sessions creates a session', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sessions')
      .send({ prompt: 'Fix the flaky websocket test' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe('CREATED');
    expect(res.body.title).toContain('websocket');
  });

  it('GET /api/sessions lists sessions', async () => {
    const res = await request(app.getHttpServer()).get('/api/sessions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('GET /api/sessions/:id/events returns events after run', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/sessions')
      .send({ prompt: 'Write a hello world script' });

    const id = created.body.id;
    await waitForIdle(app, id);

    const res = await request(app.getHttpServer()).get(`/api/sessions/${id}/events`);
    expect(res.status).toBe(200);
    expect(res.body.some((e: { type: string }) => e.type === 'user_message')).toBe(true);
    expect(res.body.some((e: { type: string }) => e.type === 'assistant_message')).toBe(true);
  });
});

async function waitForIdle(app: INestApplication, id: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request(app.getHttpServer()).get(`/api/sessions/${id}`);
    if (res.body.status === 'IDLE' || res.body.status === 'ERROR') return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Session ${id} did not reach IDLE in time`);
}
