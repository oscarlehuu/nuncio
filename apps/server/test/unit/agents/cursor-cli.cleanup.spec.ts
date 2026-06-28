import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CursorCliProvider } from '../../../src/agents/providers/cursor-cli.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';

describe('CursorCliProvider subprocess cleanup', () => {
  let provider: CursorCliProvider;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-cli-cleanup-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    const module: TestingModule = await Test.createTestingModule({
      imports: [DatabaseModule, SettingsModule, SessionsPersistenceModule],
      providers: [CursorCliProvider],
    }).compile();
    provider = module.get(CursorCliProvider);
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('dispose kills a tracked subprocess', () => {
    const kill = jest.fn();
    const proc = { kill, exited: Promise.resolve(0) };
    (provider as unknown as { activeProcesses: Map<string, unknown> }).activeProcesses.set(
      'sess-1',
      proc,
    );

    provider.dispose('sess-1');
    expect(kill).toHaveBeenCalled();
  });

  it('disposeAll clears every tracked subprocess', () => {
    const killA = jest.fn();
    const killB = jest.fn();
    const map = (provider as unknown as { activeProcesses: Map<string, { kill: () => void }> })
      .activeProcesses;
    map.set('a', { kill: killA, exited: Promise.resolve(0) } as never);
    map.set('b', { kill: killB, exited: Promise.resolve(0) } as never);

    provider.disposeAll();
    expect(killA).toHaveBeenCalled();
    expect(killB).toHaveBeenCalled();
    expect(map.size).toBe(0);
  });
});
