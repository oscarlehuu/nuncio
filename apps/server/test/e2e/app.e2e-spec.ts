import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppModule } from '../../src/app.module';

describe('Nuncio API (e2e)', () => {
  let app: INestApplication;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-e2e-'));
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
    expect(res.body.service).toBe('nuncio-server');
  });

  it('GET /api/models lists available providers', async () => {
    const res = await request(app.getHttpServer()).get('/api/models');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((p: { id: string }) => p.id === 'mock')).toBe(true);
  });

  it('runs a full session lifecycle over HTTP', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/sessions')
      .send({ prompt: 'Build the e2e flow', provider: 'mock' });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeDefined();
    expect(created.body.provider).toBe('mock');

    const id = created.body.id;
    await waitForIdle(app, id);

    const events = await request(app.getHttpServer()).get(`/api/sessions/${id}/events`);
    expect(events.status).toBe(200);
    expect(events.body.some((e: { type: string }) => e.type === 'user_message')).toBe(true);
    expect(events.body.some((e: { type: string }) => e.type === 'assistant_message')).toBe(true);

    const steer = await request(app.getHttpServer())
      .post(`/api/sessions/${id}/steer`)
      .send({ message: 'now focus on tests' });
    expect(steer.status).toBe(201);
    await waitForIdle(app, id);
    expect((await request(app.getHttpServer()).get(`/api/sessions/${id}`)).body.status).toBe('IDLE');

    const paused = await request(app.getHttpServer()).post(`/api/sessions/${id}/pause`);
    expect(paused.status).toBe(201);
    expect(paused.body.status).toBe('PAUSED');

    const archived = await request(app.getHttpServer()).post(`/api/sessions/${id}/archive`);
    expect(archived.status).toBe(201);
    expect(archived.body.status).toBe('ARCHIVED');
  });

  it('rejects creating a session with an unknown provider', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sessions')
      .send({ prompt: 'bad provider', provider: 'missing' });
    expect(res.status).toBe(400);
  });
});

async function waitForIdle(app: INestApplication, id: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request(app.getHttpServer()).get(`/api/sessions/${id}`);
    if (res.body.status === 'IDLE' || res.body.status === 'ERROR') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Session ${id} did not reach IDLE in time`);
}
