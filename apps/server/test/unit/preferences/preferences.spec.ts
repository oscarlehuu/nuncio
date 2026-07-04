import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { PreferencesController } from '../../../src/preferences/preferences.controller';
import { PreferencesRepository } from '../../../src/preferences/preferences.repository';
import { PreferencesService } from '../../../src/preferences/preferences.service';

describe('PreferencesRepository (real sqlite)', () => {
  let module: TestingModule;
  let repo: PreferencesRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-preferences-repo-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [PreferencesRepository],
    }).compile();

    repo = module.get(PreferencesRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('get returns null for a missing key (no throw)', () => {
    expect(repo.get('never-written')).toBeNull();
  });

  it('set inserts a new row and returns it', () => {
    const row = repo.set('grid.layout', '{"cols":3}');
    expect(row.key).toBe('grid.layout');
    expect(row.value).toBe('{"cols":3}');
    expect(row.updated_at).toBeGreaterThan(0);
    expect(repo.get('grid.layout')?.value).toBe('{"cols":3}');
  });

  it('set upserts an existing key (replaces value, bumps updated_at)', async () => {
    const first = repo.set('dup', 'first');
    await new Promise((r) => setTimeout(r, 5));
    const second = repo.set('dup', 'second');
    expect(second.value).toBe('second');
    expect(second.updated_at).toBeGreaterThanOrEqual(first.updated_at);
    expect(repo.get('dup')?.value).toBe('second');
  });

  it('accepts an empty-string value (TEXT NOT NULL, "" is not null)', () => {
    const row = repo.set('empty', '');
    expect(row.value).toBe('');
    expect(repo.get('empty')?.value).toBe('');
  });

  it('round-trips a large JSON blob unchanged', () => {
    const blob = JSON.stringify({ tiles: Array.from({ length: 500 }, (_, i) => ({ id: i, x: i * 2 })) });
    repo.set('big', blob);
    expect(repo.get('big')?.value).toBe(blob);
  });

  it('round-trips unicode / emoji in key and value', () => {
    repo.set('ключ-🔑', 'значение-📐-💾');
    expect(repo.get('ключ-🔑')?.value).toBe('значение-📐-💾');
  });

  it('treats a SQL-injection-shaped key as a literal (bound params)', () => {
    const evil = "x'; DROP TABLE preferences;--";
    repo.set(evil, 'safe');
    expect(repo.get(evil)?.value).toBe('safe');
    // Table still intact — an unrelated key still resolves.
    expect(repo.get('grid.layout')?.value).toBe('{"cols":3}');
  });

  it('delete removes a row and returns true', () => {
    repo.set('todelete', 'gone');
    expect(repo.delete('todelete')).toBe(true);
    expect(repo.get('todelete')).toBeNull();
  });

  it('delete returns false for a missing key (idempotent)', () => {
    expect(repo.delete('missing')).toBe(false);
  });
});

describe('PreferencesService (real sqlite)', () => {
  let module: TestingModule;
  let service: PreferencesService;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-preferences-svc-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [PreferencesRepository, PreferencesService],
    }).compile();

    service = module.get(PreferencesService);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('get returns null for a missing key', () => {
    expect(service.get('nope')).toBeNull();
  });

  it('set then get returns { value, updatedAt }', () => {
    const set = service.set('k', 'v');
    expect(set.value).toBe('v');
    expect(set.updatedAt).toBeGreaterThan(0);

    const got = service.get('k');
    expect(got).toEqual({ value: 'v', updatedAt: set.updatedAt });
  });

  it('clear removes the key (get then returns null)', () => {
    service.set('temp', 'x');
    service.clear('temp');
    expect(service.get('temp')).toBeNull();
  });

  it('clear on a missing key does not throw', () => {
    expect(() => service.clear('was-never-here')).not.toThrow();
  });
});

describe('PreferencesController', () => {
  it('get delegates to service and returns null for a missing key (no 404)', () => {
    const get = jest.fn(() => null);
    const controller = new PreferencesController({ get } as never);
    expect(controller.get('missing')).toBeNull();
    expect(get).toHaveBeenCalledWith('missing');
  });

  it('get returns the value object for a present key', () => {
    const value = { value: '{"cols":3}', updatedAt: 123 };
    const controller = new PreferencesController({ get: () => value } as never);
    expect(controller.get('grid.layout')).toBe(value);
  });

  it('update calls service.set and returns its result', () => {
    const result = { value: 'v', updatedAt: 999 };
    const set = jest.fn(() => result);
    const controller = new PreferencesController({ set } as never);
    expect(controller.update('k', { value: 'v' })).toBe(result);
    expect(set).toHaveBeenCalledWith('k', 'v');
  });

  it('update accepts an explicit empty-string value', () => {
    const set = jest.fn(() => ({ value: '', updatedAt: 1 }));
    const controller = new PreferencesController({ set } as never);
    expect(() => controller.update('k', { value: '' })).not.toThrow();
    expect(set).toHaveBeenCalledWith('k', '');
  });

  it('update rejects a missing value field with BadRequestException', () => {
    const controller = new PreferencesController({} as never);
    expect(() => controller.update('k', {} as never)).toThrow(BadRequestException);
  });

  it('update rejects a null body with BadRequestException', () => {
    const controller = new PreferencesController({} as never);
    expect(() => controller.update('k', null as never)).toThrow(BadRequestException);
  });

  it('update rejects a non-string value (number/object) with BadRequestException', () => {
    const controller = new PreferencesController({} as never);
    expect(() => controller.update('k', { value: 123 } as never)).toThrow(BadRequestException);
    expect(() => controller.update('k', { value: {} } as never)).toThrow(BadRequestException);
    expect(() => controller.update('k', { value: null } as never)).toThrow(BadRequestException);
  });

  it('remove calls service.clear and returns { ok: true } even for a missing key', () => {
    const clear = jest.fn();
    const controller = new PreferencesController({ clear } as never);
    expect(controller.remove('k')).toEqual({ ok: true });
    expect(clear).toHaveBeenCalledWith('k');
  });
});
