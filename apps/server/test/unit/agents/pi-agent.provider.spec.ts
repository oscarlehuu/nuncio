import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiAgentProvider, resolveModelId } from '../../../src/agents/providers/pi-agent.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';

describe('PiAgentProvider', () => {
  let module: TestingModule;
  let provider: PiAgentProvider;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pi-provider-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    process.env.NUNCIO_FORCE_MOCK = '1';

    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule],
      providers: [PiAgentProvider],
    }).compile();

    provider = module.get(PiAgentProvider);
  });

  afterAll(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.NUNCIO_FORCE_MOCK;
  });

  it('is unavailable when NUNCIO_FORCE_MOCK is set', async () => {
    expect(await provider.isAvailable()).toBe(false);
  });

  it('dispose is a no-op for an unknown session', () => {
    expect(() => provider.dispose('no-such-session')).not.toThrow();
  });
});

describe('resolveModelId', () => {
  it('splits provider:modelId (colon) and delegates to find', () => {
    const find = jest.fn((provider: string, id: string) => ({ provider, id }));
    expect(resolveModelId('anthropic:claude-opus-4', find)).toEqual({
      provider: 'anthropic',
      id: 'claude-opus-4',
    });
    expect(find).toHaveBeenCalledWith('anthropic', 'claude-opus-4');
  });

  it('splits provider/modelId (slash, Pi SDK convention) and delegates to find', () => {
    const find = jest.fn((provider: string, id: string) => ({ provider, id }));
    expect(resolveModelId('openai/gpt-5.5', find)).toEqual({
      provider: 'openai',
      id: 'gpt-5.5',
    });
    expect(find).toHaveBeenCalledWith('openai', 'gpt-5.5');
  });

  it('returns undefined for ids without a provider separator', () => {
    const find = jest.fn();
    expect(resolveModelId('claude-fable-5', find)).toBeUndefined();
    expect(resolveModelId(':leadingslice', find)).toBeUndefined();
    expect(resolveModelId('/leadingslice', find)).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });

  it('returns undefined for empty or null input', () => {
    const find = jest.fn();
    expect(resolveModelId('', find)).toBeUndefined();
    expect(resolveModelId(null, find)).toBeUndefined();
    expect(resolveModelId(undefined, find)).toBeUndefined();
    expect(resolveModelId('   ', find)).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });

  it('propagates an unresolved lookup as undefined', () => {
    const find = jest.fn(() => undefined);
    expect(resolveModelId('anthropic:unknown-model', find)).toBeUndefined();
    expect(find).toHaveBeenCalledWith('anthropic', 'unknown-model');
  });
});
