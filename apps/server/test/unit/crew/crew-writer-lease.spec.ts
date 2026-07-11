import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewWriterLeaseService } from '../../../src/crew/crew-writer-lease.service';
import { DatabaseService } from '../../../src/db/database.service';
import { ensureCrewSchema } from '../../../src/crew/persistence/crew-schema';
import { CrewWriterLeasesRepository } from '../../../src/crew/persistence/crew-writer-leases.repository';

describe('CrewWriterLeaseService', () => {
  let dataDir: string;
  let database: DatabaseService;
  let service: CrewWriterLeaseService;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-crew-lease-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    database = new DatabaseService();
    ensureCrewSchema(database);
    service = new CrewWriterLeaseService(new CrewWriterLeasesRepository(database));
  });
  afterEach(() => {
    database.onModuleDestroy();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('grants exactly one writer lease to the fixed Builder member', () => {
    const first = service.acquire({
      runId: 'r1', memberSessionId: 'm1', memberKey: 'builder:primary', startingHead: 'a'.repeat(40),
    });
    expect(first).toMatchObject({ runId: 'r1', memberSessionId: 'm1', startingHead: 'a'.repeat(40) });
    expect(first.token).toBeTruthy();
    expect(() => service.acquire({
      runId: 'r1', memberSessionId: 'm2', memberKey: 'builder:primary', startingHead: 'a'.repeat(40),
    })).toThrow('already has a writer');
  });

  it('rejects Foreman/Reviewer and protects release with the lease token', () => {
    expect(() => service.acquire({
      runId: 'r1', memberSessionId: 'm1', memberKey: 'reviewer:primary', startingHead: 'a'.repeat(40),
    })).toThrow('Builder');
    const lease = service.acquire({
      runId: 'r1', memberSessionId: 'm1', memberKey: 'builder:primary', startingHead: 'a'.repeat(40),
    });
    expect(service.release('r1', 'wrong')).toBe(false);
    expect(service.release('r1', lease.token)).toBe(true);
  });
});
