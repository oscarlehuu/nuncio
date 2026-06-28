import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { DatabaseService } from '../../../src/db/database.service';
import { SettingsRepository } from '../../../src/settings/persistence/settings.repository';
import { SettingsService, SETTINGS_KEY } from '../../../src/settings/settings.service';
import { SETTING_DEFINITIONS } from '../../../src/settings/settings.registry';

const TEST_KEY = Buffer.alloc(32, 7);

describe('SettingsService', () => {
  let module: TestingModule;
  let service: SettingsService;
  let repo: SettingsRepository;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-settings-svc-'));
    process.env.NUNCIO_DATA_DIR = dataDir;

    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        SettingsRepository,
        { provide: SETTINGS_KEY, useValue: TEST_KEY },
        SettingsService,
      ],
    }).compile();

    service = module.get(SettingsService);
    repo = module.get(SettingsRepository);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  // Clean env + DB between tests so they don't leak state.
  beforeEach(() => {
    for (const def of SETTING_DEFINITIONS) {
      delete process.env[def.envVar as string];
      if (def.altEnvVar) delete process.env[def.altEnvVar];
      repo.delete(def.key);
    }
  });

  describe('resolve (DB → env → default fallback)', () => {
    it('returns undefined when no DB row, no env, no default', () => {
      expect(service.resolve('CURSOR_API_KEY')).toBeUndefined();
    });

    it('returns the env value when set and no DB row (back-compat)', () => {
      process.env.CURSOR_API_KEY = 'env-key';
      expect(service.resolve('CURSOR_API_KEY')).toBe('env-key');
    });

    it('returns the DB value when a DB row exists (DB wins over env)', () => {
      process.env.CURSOR_API_KEY = 'env-key';
      service.set('CURSOR_API_KEY', 'db-key');
      expect(service.resolve('CURSOR_API_KEY')).toBe('db-key');
    });

    it('returns the default when no DB and no env', () => {
      expect(service.resolve('NUNCIO_WORKSPACES_DIR')).toBe('~/.nuncio/workspaces');
    });

    it('honours altEnvVar when envVar is absent (PI_AGENT_DIR / PI_CODING_AGENT_DIR)', () => {
      delete process.env.PI_CODING_AGENT_DIR;
      process.env.PI_AGENT_DIR = '/custom/pi';
      expect(service.resolve('PI_AGENT_DIR')).toBe('/custom/pi');
    });

    it('prefers envVar over altEnvVar when both are set', () => {
      process.env.PI_CODING_AGENT_DIR = '/primary';
      process.env.PI_AGENT_DIR = '/secondary';
      expect(service.resolve('PI_AGENT_DIR')).toBe('/primary');
    });

    it('throws when resolving an unknown key', () => {
      expect(() => service.resolve('UNKNOWN_KEY')).toThrow(/unknown setting/i);
    });

    it('falls back to env when a DB secret row cannot be decrypted', () => {
      process.env.CURSOR_API_KEY = 'env-key';
      repo.set('CURSOR_API_KEY', 'v1:deadbeef:bad:ciphertext');
      expect(service.resolve('CURSOR_API_KEY')).toBe('env-key');
      expect(service.resolveSource('CURSOR_API_KEY')).toEqual({
        value: 'env-key',
        source: 'env',
      });
    });
  });

  describe('resolveSource', () => {
    it('reports source = env when env provides the value', () => {
      process.env.CURSOR_API_KEY = 'env-key';
      expect(service.resolveSource('CURSOR_API_KEY')).toEqual({
        value: 'env-key',
        source: 'env',
      });
    });

    it('reports source = db when a DB row exists', () => {
      service.set('CURSOR_API_KEY', 'db-key');
      expect(service.resolveSource('CURSOR_API_KEY')).toEqual({
        value: 'db-key',
        source: 'db',
      });
    });

    it('reports source = default when only the registry default applies', () => {
      expect(service.resolveSource('NUNCIO_WORKSPACES_DIR')).toEqual({
        value: '~/.nuncio/workspaces',
        source: 'default',
      });
    });

    it('reports source = null when nothing provides a value', () => {
      expect(service.resolveSource('CURSOR_API_KEY')).toEqual({ value: undefined, source: null });
    });
  });

  describe('set (encryption + onChange)', () => {
    it('persists plaintext for non-secret types', () => {
      service.set('NUNCIO_PROJECT_ROOTS', '~/code,~/work');
      expect(repo.get('NUNCIO_PROJECT_ROOTS')?.value).toBe('~/code,~/work');
    });

    it('persists encrypted ciphertext for secret types (raw value never stored)', () => {
      service.set('CURSOR_API_KEY', 'sk-cursor-secret-12345');
      const stored = repo.get('CURSOR_API_KEY')?.value;
      expect(stored).toBeDefined();
      expect(stored).not.toBe('sk-cursor-secret-12345');
      expect(stored!.startsWith('v1:')).toBe(true);
    });

    it('resolve returns the decrypted plaintext after set', () => {
      service.set('CURSOR_API_KEY', 'sk-cursor-secret-12345');
      expect(service.resolve('CURSOR_API_KEY')).toBe('sk-cursor-secret-12345');
    });

    it('emits an onChange listener with the changed key', () => {
      const seen: string[] = [];
      service.onChange((key) => seen.push(key));
      service.set('NUNCIO_PROJECT_ROOTS', '/tmp/projects');
      expect(seen).toContain('NUNCIO_PROJECT_ROOTS');
    });

    it('throws when setting an unknown key', () => {
      expect(() => service.set('NOPE', 'x')).toThrow(/unknown setting/i);
    });

    it('allows setting an explicit empty string (override to blank)', () => {
      process.env.CURSOR_API_KEY = 'env-key';
      service.set('CURSOR_API_KEY', '');
      expect(service.resolve('CURSOR_API_KEY')).toBe('');
      // source is 'db' because a DB row exists, even though it's empty
      expect(service.resolveSource('CURSOR_API_KEY').source).toBe('db');
    });
  });

  describe('clear (delete DB row, fallback to env/default)', () => {
    it('removes the DB row so resolve falls back to env', () => {
      process.env.CURSOR_API_KEY = 'env-key';
      service.set('CURSOR_API_KEY', 'db-key');
      expect(service.resolve('CURSOR_API_KEY')).toBe('db-key');
      service.clear('CURSOR_API_KEY');
      expect(service.resolve('CURSOR_API_KEY')).toBe('env-key');
    });

    it('emits an onChange listener with the changed key', () => {
      const seen: string[] = [];
      service.set('NUNCIO_PROJECT_ROOTS', '/tmp/projects');
      service.onChange((key) => seen.push(key));
      service.clear('NUNCIO_PROJECT_ROOTS');
      expect(seen).toContain('NUNCIO_PROJECT_ROOTS');
    });

    it('throws when clearing an unknown key', () => {
      expect(() => service.clear('NOPE')).toThrow(/unknown setting/i);
    });
  });

  describe('list / get (DTOs with secret masking)', () => {
    it('list returns one DTO per registry entry with metadata', () => {
      const dtos = service.list();
      expect(dtos.length).toBe(SETTING_DEFINITIONS.length);
      for (const def of SETTING_DEFINITIONS) {
        const dto = dtos.find((d) => d.key === def.key);
        expect(dto).toBeDefined();
        expect(dto!.label).toBe(def.label);
        expect(dto!.type).toBe(def.type);
        expect(dto!.category).toBe(def.category);
      }
    });

    it('list masks secret values and never returns raw plaintext', () => {
      service.set('CURSOR_API_KEY', 'sk-cursor-abcdef1234');
      const dto = service.list().find((d) => d.key === 'CURSOR_API_KEY');
      expect(dto!.hasValue).toBe(true);
      expect(dto!.source).toBe('db');
      expect(dto!.value).toBe('••••1234'); // masked, last 4
      expect(dto!.value).not.toContain('sk-cursor');
    });

    it('list returns raw value for non-secret types', () => {
      process.env.NUNCIO_PROJECT_ROOTS = '~/code';
      const dto = service.list().find((d) => d.key === 'NUNCIO_PROJECT_ROOTS');
      expect(dto!.hasValue).toBe(true);
      expect(dto!.source).toBe('env');
      expect(dto!.value).toBe('~/code');
    });

    it('list reports hasValue=false and value=null for unset secrets', () => {
      const dto = service.list().find((d) => d.key === 'CURSOR_API_KEY');
      expect(dto!.hasValue).toBe(false);
      expect(dto!.value).toBeNull();
    });

    it('get returns null for an unknown key', () => {
      expect(service.get('NOPE')).toBeNull();
    });

    it('get returns the DTO for a known key', () => {
      const dto = service.get('CURSOR_API_KEY');
      expect(dto?.key).toBe('CURSOR_API_KEY');
    });
  });
});
