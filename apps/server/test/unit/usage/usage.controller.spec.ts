import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppModule } from '../../../src/app.module';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

describe('GET /api/usage', () => {
  let app: INestApplication;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-usage-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();
    const moduleFixture = await withSimulatedCursorProvider(
      Test.createTestingModule({ imports: [AppModule] }),
    ).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('returns three provider snapshots', async () => {
    const res = await request(app.getHttpAdapter().getInstance()).get('/api/usage');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((s: { provider: string }) => s.provider).sort()).toEqual([
      'claude',
      'codex',
      'cursor',
    ]);
    for (const snap of res.body) {
      expect(['ok', 'needs-auth', 'unsupported', 'error']).toContain(snap.status);
      expect(Array.isArray(snap.limits)).toBe(true);
      expect(Array.isArray(snap.usageLines)).toBe(true);
    }
  });

  it('404s unknown providers', async () => {
    const res = await request(app.getHttpAdapter().getInstance()).get('/api/usage/pi');
    expect(res.status).toBe(404);
  });

  it('returns usage history shape', async () => {
    const res = await request(app.getHttpAdapter().getInstance()).get('/api/usage/history?days=7');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.days)).toBe(true);
    expect(res.body.days).toHaveLength(7);
    expect(res.body.totals).toEqual(
      expect.objectContaining({
        claude: expect.any(Number),
        codex: expect.any(Number),
        cursor: expect.any(Number),
      }),
    );
    expect(res.body.estimatedUsdTotals).toEqual(
      expect.objectContaining({
        claude: expect.any(Number),
        codex: expect.any(Number),
        cursor: expect.any(Number),
      }),
    );
    expect(typeof res.body.updatedAt).toBe('string');
    for (const day of res.body.days) {
      expect(typeof day.date).toBe('string');
      expect(typeof day.claude).toBe('number');
      expect(typeof day.codex).toBe('number');
      expect(typeof day.cursor).toBe('number');
    }
  });
});
