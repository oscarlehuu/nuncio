import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentsModule } from '../../../src/agents/agents.module';
import { CodexAgentProvider } from '../../../src/agents/providers/codex-agent.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { ModelsService } from '../../../src/models/models.service';
import {
  configureSimulatedCursorEnv,
  withSimulatedCursorProvider,
} from '../../helpers/simulated-cursor-app';

describe('ModelsService', () => {
  let module: TestingModule;
  let models: ModelsService;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-models-svc-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    configureSimulatedCursorEnv();

    module = await withSimulatedCursorProvider(
      Test.createTestingModule({
        imports: [DatabaseModule, AgentsModule],
        providers: [ModelsService],
      }),
    )
      .overrideProvider(CodexAgentProvider)
      .useValue({
        id: 'codex',
        name: 'Codex',
        isAvailable: async () => false,
        listModels: async () => [],
        dispose: () => undefined,
      })
      .compile();

    models = module.get(ModelsService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.CURSOR_API_KEY;
  });

  it('aggregates models from available providers only and attaches provider capabilities', async () => {
    const result = await models.list();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('cursor');
    expect(result[0].capabilities).toEqual({
      interrupt: false,
      modelSwitch: 'none',
      effortSwitch: 'none',
      images: false,
    });
  });
});
