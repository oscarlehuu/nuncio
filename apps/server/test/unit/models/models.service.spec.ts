import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { DatabaseModule } from '../../../src/db/database.module';
import { ModelsService } from '../../../src/models/models.service';

describe('ModelsService', () => {
  let module: TestingModule;
  let models: ModelsService;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-models-svc-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    process.env.NUNCIO_FORCE_MOCK = '1';

    module = await Test.createTestingModule({
      imports: [DatabaseModule, AgentsModule],
      providers: [ModelsService],
    }).compile();

    models = module.get(ModelsService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.NUNCIO_FORCE_MOCK;
  });

  it('aggregates models from available providers only', async () => {
    const result = await models.list();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('mock');
  });
});
