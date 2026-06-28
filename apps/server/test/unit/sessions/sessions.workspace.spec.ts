import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';

describe('SessionsRepository workspace field', () => {
  let module: TestingModule;
  let sessions: SessionsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-workspace-spec-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule],
    }).compile();

    sessions = module.get(SessionsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('persists workspace when provided on create', () => {
    const created = sessions.create({ prompt: 'p', provider: 'cursor', workspace: '/tmp/x' });
    expect(created.workspace).toBe('/tmp/x');
    expect(sessions.findById(created.id)?.workspace).toBe('/tmp/x');
  });

  it('defaults workspace to null when omitted', () => {
    const created = sessions.create({ prompt: 'p', provider: 'cursor' });
    expect(created.workspace).toBeNull();
  });
});
