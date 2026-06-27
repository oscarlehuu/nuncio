import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { SettingsRepository } from '../../../src/settings/persistence/settings.repository';

describe('SettingsRepository', () => {
  let module: TestingModule;
  let repo: SettingsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-settings-repo-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [SettingsRepository],
    }).compile();

    repo = module.get(SettingsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('get returns null for a missing key', () => {
    expect(repo.get('NOPE')).toBeNull();
  });

  it('set inserts a new row and returns it', () => {
    const row = repo.set('K1', 'v1');
    expect(row.key).toBe('K1');
    expect(row.value).toBe('v1');
    expect(row.updated_at).toBeGreaterThan(0);
    expect(repo.get('K1')?.value).toBe('v1');
  });

  it('set upserts an existing row (replaces value, bumps updated_at)', async () => {
    const first = repo.set('K2', 'first');
    await new Promise((r) => setTimeout(r, 5));
    const second = repo.set('K2', 'second');
    expect(second.value).toBe('second');
    expect(second.updated_at).toBeGreaterThan(first.updated_at);
    expect(repo.get('K2')?.value).toBe('second');
  });

  it('list returns all rows ordered by key', () => {
    repo.set('zebra', 'z');
    repo.set('alpha', 'a');
    repo.set('mango', 'm');
    const keys = repo.list().map((r) => r.key);
    expect(keys).toContain('alpha');
    expect(keys).toContain('mango');
    expect(keys).toContain('zebra');
    const alphaIdx = keys.indexOf('alpha');
    const mangoIdx = keys.indexOf('mango');
    const zebraIdx = keys.indexOf('zebra');
    expect(alphaIdx).toBeLessThan(mangoIdx);
    expect(mangoIdx).toBeLessThan(zebraIdx);
  });

  it('delete removes a row and returns true', () => {
    repo.set('TODELETE', 'gone');
    expect(repo.delete('TODELETE')).toBe(true);
    expect(repo.get('TODELETE')).toBeNull();
  });

  it('delete returns false for a missing key', () => {
    expect(repo.delete('MISSING')).toBe(false);
  });

  it('exists returns true only for stored keys', () => {
    repo.set('EXISTS', 'y');
    expect(repo.exists('EXISTS')).toBe(true);
    expect(repo.exists('NOPE')).toBe(false);
  });
});
