import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { AttentionController } from '../../../src/attention/attention.controller';
import { AttentionRepository } from '../../../src/attention/attention.repository';
import { AttentionService } from '../../../src/attention/attention.service';

/** Thin REST contract for the phone inbox: list (ranked + counts), ack, resolve. */
describe('AttentionController', () => {
  let module: TestingModule;
  let controller: AttentionController;
  let svc: AttentionService;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-attention-ctrl-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      controllers: [AttentionController],
      providers: [AttentionRepository, AttentionService],
    }).compile();
    controller = module.get(AttentionController);
    svc = module.get(AttentionService);
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('GET /attention returns ranked items plus badge counts', () => {
    svc.raise({ kind: 'anomaly', subjectId: 's1', title: 'low' });
    svc.raise({ kind: 'permission', subjectId: 's2', title: 'high' });
    const body = controller.list();
    expect(body.items.map((i) => i.subjectId)).toEqual(['s2', 's1']); // permission first
    expect(body.counts).toMatchObject({ total: 2, unacked: 2 });
  });

  it('GET /attention/counts returns the badge counts alone', () => {
    svc.raise({ kind: 'permission', subjectId: 's1', title: 't' });
    expect(controller.counts()).toMatchObject({ total: 1, unacked: 1 });
  });

  it('POST /attention/:id/ack acks the item (stays open, badge drops)', () => {
    const item = svc.raise({ kind: 'permission', subjectId: 's1', title: 't' });
    const acked = controller.ack(item.id);
    expect(acked.status).toBe('open');
    expect(controller.counts().unacked).toBe(0);
  });

  it('POST /attention/:id/resolve resolves the item', () => {
    const item = svc.raise({ kind: 'permission', subjectId: 's1', title: 't' });
    expect(controller.resolve(item.id).status).toBe('resolved');
    expect(controller.counts().total).toBe(0);
  });

  it('ack / resolve of an unknown id → 404', () => {
    expect(() => controller.ack('nope')).toThrow(NotFoundException);
    expect(() => controller.resolve('nope')).toThrow(NotFoundException);
  });
});
