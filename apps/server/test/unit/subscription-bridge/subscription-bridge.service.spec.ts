import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Test, type TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseModule } from '../../../src/db/database.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { SettingsService } from '../../../src/settings/settings.service';
import { CLAUDE_STATIC_MODELS } from '../../../src/agents/providers/claude-agent.models';
import { SubscriptionBridgeService } from '../../../src/subscription-bridge/subscription-bridge.service';

describe('SubscriptionBridgeService', () => {
  let module: TestingModule;
  let settings: SettingsService;
  let bridge: SubscriptionBridgeService;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-sub-bridge-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule, SettingsModule],
      providers: [SubscriptionBridgeService],
    }).compile();
    settings = module.get(SettingsService);
    bridge = module.get(SubscriptionBridgeService);
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.NUNCIO_CLIPROXY_ENABLED;
    delete process.env.NUNCIO_CLIPROXY_BASE_URL;
    delete process.env.NUNCIO_CLIPROXY_API_KEY;
  });

  it('reports disabled when the enable flag is off', async () => {
    const status = await bridge.status();
    expect(status.enabled).toBe(false);
    expect(status.online).toBe(false);
  });

  it('health-checks CLIProxy and reports Codex account from catalog', async () => {
    settings.set('NUNCIO_CLIPROXY_ENABLED', '1');
    settings.set('NUNCIO_CLIPROXY_API_KEY', 'test-key');
    settings.set('NUNCIO_CLIPROXY_BASE_URL', 'http://127.0.0.1:8317');

    bridge.fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'gpt-5.6-sol', display_name: 'GPT 5.6 Sol', owned_by: 'openai' },
            { id: 'claude-opus-4-8', display_name: 'Opus', owned_by: 'anthropic' },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const status = await bridge.status({ forceRefresh: true });
    expect(status.enabled).toBe(true);
    expect(status.online).toBe(true);
    expect(status.accounts).toEqual({ claude: true, codex: true });
    expect(status.modelCount).toBe(2);
  });

  it('merges Codex models into the Claude catalog when online', async () => {
    settings.set('NUNCIO_CLIPROXY_ENABLED', '1');
    settings.set('NUNCIO_CLIPROXY_API_KEY', 'test-key');
    bridge.fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'gpt-5.6-sol', display_name: 'GPT 5.6 Sol', owned_by: 'openai' }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const merged = await bridge.mergeIntoClaudeCatalog(CLAUDE_STATIC_MODELS);
    const group = merged[0]?.groups?.find((g) => g.id === 'codex-sub');
    expect(group?.models).toEqual([
      {
        id: 'claude:gpt-5.6-sol',
        name: 'GPT 5.6 Sol',
        sub: 'via Subscription bridge',
        badge: 'Codex sub',
      },
    ]);
  });

  it('fail-closes resolveClaudeSdkEnv when bridge is offline', async () => {
    settings.set('NUNCIO_CLIPROXY_ENABLED', '1');
    settings.set('NUNCIO_CLIPROXY_API_KEY', 'test-key');
    bridge.fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(bridge.resolveClaudeSdkEnv('gpt-5.6-sol')).rejects.toThrow(/offline/i);
  });

  it('returns SDK env pointing at CLIProxy for Codex models when healthy', async () => {
    settings.set('NUNCIO_CLIPROXY_ENABLED', '1');
    settings.set('NUNCIO_CLIPROXY_API_KEY', 'bridge-secret');
    settings.set('NUNCIO_CLIPROXY_BASE_URL', 'http://127.0.0.1:8317');
    bridge.fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'gpt-5.6-sol', display_name: 'GPT 5.6 Sol', owned_by: 'openai' }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const env = await bridge.resolveClaudeSdkEnv('gpt-5.6-sol');
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317',
      ANTHROPIC_AUTH_TOKEN: 'bridge-secret',
      ANTHROPIC_API_KEY: 'bridge-secret',
    });
  });

  it('returns null env for native Claude models', async () => {
    expect(await bridge.resolveClaudeSdkEnv('opus')).toBeNull();
  });

  it('builds Claude Code env exports for copy-paste', async () => {
    settings.set('NUNCIO_CLIPROXY_ENABLED', '1');
    settings.set('NUNCIO_CLIPROXY_API_KEY', 'bridge-secret');
    bridge.fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;

    const dto = await bridge.claudeCodeEnv();
    expect(dto.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8317');
    expect(dto.env.ANTHROPIC_AUTH_TOKEN).toBe('bridge-secret');
    expect(dto.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe('1');
    expect(dto.exports).toContain('export ANTHROPIC_BASE_URL=');
  });
});
