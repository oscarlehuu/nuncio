import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextModule } from '../../../src/context/context.module';
import { ContextFactsService } from '../../../src/context/context-facts.service';
import { DatabaseModule } from '../../../src/db/database.module';

describe('ContextFactsController (level 3)', () => {
  let module: TestingModule;
  let app: INestApplication;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-facts-http-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({ imports: [DatabaseModule, ContextModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  const http = () => request(app.getHttpServer());

  it('PUT upserts a founder fact, GET lists it by project, DELETE removes it', async () => {
    const put = await http()
      .put('/api/context-facts')
      .send({ projectPath: '/repo', key: 'build-command', value: 'make weird-build', pinned: true });
    expect(put.status).toBe(200);
    expect(put.body.provenance).toBe('founder');
    expect(put.body.pinned).toBe(true);

    const list = await http().get('/api/context-facts').query({ projectPath: '/repo' });
    expect(list.status).toBe(200);
    expect(list.body.map((f: { key: string }) => f.key)).toContain('build-command');

    const del = await http().delete(`/api/context-facts/${put.body.id}`);
    expect(del.status).toBe(200);
    expect((await http().get('/api/context-facts').query({ projectPath: '/repo' })).body).toHaveLength(0);
  });

  it('GET without projectPath is a 400', async () => {
    expect((await http().get('/api/context-facts')).status).toBe(400);
  });

  it('PUT rejects a bad slug with 400', async () => {
    const res = await http().put('/api/context-facts').send({ projectPath: '/repo', key: 'Bad Key', value: 'v' });
    expect(res.status).toBe(400);
  });

  it('facts never bleed between projects', async () => {
    await http().put('/api/context-facts').send({ projectPath: '/proj-a', key: 'shared', value: 'a' });
    await http().put('/api/context-facts').send({ projectPath: '/proj-b', key: 'shared', value: 'b' });
    const a = await http().get('/api/context-facts').query({ projectPath: '/proj-a' });
    expect(a.body.map((f: { value: string }) => f.value)).toEqual(['a']);
  });

  it('proposal accept flow flips the fact to founder provenance', async () => {
    const p = '/proposals-http';
    await http().put('/api/context-facts').send({ projectPath: p, key: 'gc', value: 'founder-val' });

    // An agent proposal (the tool path); then accept it over HTTP.
    const svc = module.get(ContextFactsService);
    const rej = svc.upsert({ projectPath: p, key: 'gc', value: 'agent-val', provenance: 'agent', sourceSessionId: 's' });
    expect(rej.written).toBe(false);

    const proposals = await http().get('/api/context-facts/proposals').query({ projectPath: p });
    expect(proposals.body).toHaveLength(1);

    const accept = await http().post(`/api/context-facts/proposals/${rej.proposalId}/accept`);
    expect(accept.status).toBe(201);
    const facts = await http().get('/api/context-facts').query({ projectPath: p });
    const fact = facts.body.find((f: { key: string }) => f.key === 'gc');
    expect(fact.value).toBe('agent-val');
    expect(fact.provenance).toBe('founder');
  });
});
