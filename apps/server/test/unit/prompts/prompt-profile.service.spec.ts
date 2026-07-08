import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseModule } from '../../../src/db/database.module';
import { PromptsModule } from '../../../src/prompts/prompts.module';
import { PromptProfileService } from '../../../src/prompts/prompt-profile.service';
import { SettingsModule } from '../../../src/settings/settings.module';
import { SettingsService } from '../../../src/settings/settings.service';

describe('PromptProfileService', () => {
  let module: TestingModule;
  let profiles: PromptProfileService;
  let settings: SettingsService;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-profile-svc-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule, SettingsModule, PromptsModule],
    }).compile();
    profiles = module.get(PromptProfileService);
    settings = module.get(SettingsService);
  });

  afterAll(async () => {
    settings.clear('NUNCIO_PROMPT_PROFILE_CURSOR');
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
  });

  it('a settings change takes effect on an already-cached (provider, model)', () => {
    // Prime the cache with the empty pass-through profile.
    expect(profiles.resolve('cursor', 'some-model').sections.briefWrapper).toBeUndefined();

    settings.set(
      'NUNCIO_PROMPT_PROFILE_CURSOR',
      '---\nprovider: cursor\n---\n\n## brief-wrapper\nOVERRIDE {{content}}\n',
    );

    // Without a settings-change cache bust this still returns the stale empty profile.
    expect(profiles.resolve('cursor', 'some-model').sections.briefWrapper).toBe('OVERRIDE {{content}}');
  });

  it('resolves to the pass-through profile for a provider with no override setting key', () => {
    // The override key is derived from the provider id
    // (NUNCIO_PROMPT_PROFILE_MOCK). No such key is registered, and
    // settings.resolve() throws on unregistered keys by design — resolving a
    // profile for such a provider must fall through to pass-through, never throw
    // (otherwise session creation for that provider crashes).
    expect(() => profiles.resolve('mock', 'mock:default')).not.toThrow();
    expect(profiles.resolve('mock', 'mock:default').sections.briefWrapper).toBeUndefined();
  });

  it('propagates a resolve failure on a REGISTERED key instead of degrading to pass-through', () => {
    // A registered key that fails to resolve (e.g. a DB/decrypt error) is a real
    // fault — it must surface, not silently become the pass-through profile. The
    // membership gate (settings.get) reports the key as known, so resolve() runs
    // and its throw propagates.
    const boom = new Error('db read failed');
    const faultySettings = {
      // Non-null => the key is "registered" for the membership gate.
      get: () => ({ key: 'NUNCIO_PROMPT_PROFILE_CURSOR' }),
      resolve: () => {
        throw boom;
      },
      onChange: () => undefined,
    } as unknown as SettingsService;
    const service = new PromptProfileService(faultySettings);
    expect(() => service.resolve('cursor', 'some-model')).toThrow('db read failed');
  });

  it('clearing the setting also takes effect without a restart', () => {
    settings.set(
      'NUNCIO_PROMPT_PROFILE_CURSOR',
      '---\nprovider: cursor\n---\n\n## brief-wrapper\nOVERRIDE {{content}}\n',
    );
    expect(profiles.resolve('cursor', 'other-model').sections.briefWrapper).toBe('OVERRIDE {{content}}');

    settings.clear('NUNCIO_PROMPT_PROFILE_CURSOR');
    expect(profiles.resolve('cursor', 'other-model').sections.briefWrapper).toBeUndefined();
  });
});
