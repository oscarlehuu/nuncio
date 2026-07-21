import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Test, type TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAgentProvider } from '../../../src/agents/providers/claude-agent.provider';
import { DatabaseModule } from '../../../src/db/database.module';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';
import { SessionsRepository } from '../../../src/sessions/persistence/sessions.repository';
import { SessionsPersistenceModule } from '../../../src/sessions/sessions.persistence.module';
import { SettingsModule } from '../../../src/settings/settings.module';
import { SettingsService } from '../../../src/settings/settings.service';
import { SubscriptionBridgeModule } from '../../../src/subscription-bridge/subscription-bridge.module';
import { SubscriptionBridgeService } from '../../../src/subscription-bridge/subscription-bridge.service';
import type {
  ClaudeQuery,
  ClaudeQueryOptions,
  ClaudeSdkMessage,
} from '../../../src/agents/providers/claude-agent.sdk';

class CapturingQuery implements ClaudeQuery {
  constructor(private readonly sessionId: string) {}
  async interrupt(): Promise<void> {}
  async setModel(): Promise<void> {}
  async *[Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    yield { type: 'system', subtype: 'init', session_id: this.sessionId };
    yield { type: 'result', subtype: 'success', result: 'ok' };
  }
}

function stubFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('ClaudeAgentProvider × Subscription bridge', () => {
  let module: TestingModule;
  let provider: ClaudeAgentProvider;
  let sessions: SessionsRepository;
  let settings: SettingsService;
  let bridge: SubscriptionBridgeService;
  let dataDir: string;
  let capturedOptions: ClaudeQueryOptions | undefined;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-claude-bridge-'));
    process.env.NUNCIO_DATA_DIR = dataDir;
    module = await Test.createTestingModule({
      imports: [DatabaseModule, SessionsPersistenceModule, SettingsModule, SubscriptionBridgeModule],
      providers: [ClaudeAgentProvider],
    }).compile();
    sessions = module.get(SessionsRepository);
    settings = module.get(SettingsService);
    bridge = module.get(SubscriptionBridgeService);
    provider = module.get(ClaudeAgentProvider);
    provider.bundledBinaryPath = '/fake/claude';
    capturedOptions = undefined;
    provider.queryFactory = ({ options }) => {
      capturedOptions = options;
      return new CapturingQuery('thread-bridge');
    };
    process.env.ANTHROPIC_API_KEY = 'sk-native';
    provider.bustCache();
  });

  afterEach(async () => {
    await module.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_DATA_DIR;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('injects CLIProxy env when running a Codex-sub model on Claude', async () => {
    settings.set('NUNCIO_CLIPROXY_ENABLED', '1');
    settings.set('NUNCIO_CLIPROXY_API_KEY', 'bridge-secret');
    bridge.fetchImpl = stubFetch({
      data: [{ id: 'gpt-5.6-sol', display_name: 'GPT 5.6 Sol', owned_by: 'openai' }],
    });

    const row = sessions.create({
      prompt: 'hi',
      model: 'claude:gpt-5.6-sol',
      provider: 'claude',
      workspace: dataDir,
    });

    await provider.run(row.id, 'hi', {
      model: 'claude:gpt-5.6-sol',
      workspace: dataDir,
    });

    expect(capturedOptions?.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8317');
    expect(capturedOptions?.env?.ANTHROPIC_AUTH_TOKEN).toBe('bridge-secret');
    expect(capturedOptions?.model).toBe('gpt-5.6-sol');
  });

  it('fail-closes a Codex-sub model when the bridge is offline', async () => {
    settings.set('NUNCIO_CLIPROXY_ENABLED', '1');
    settings.set('NUNCIO_CLIPROXY_API_KEY', 'bridge-secret');
    bridge.fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const row = sessions.create({
      prompt: 'hi',
      model: 'claude:gpt-5.6-sol',
      provider: 'claude',
      workspace: dataDir,
    });
    const events = module.get(EventsRepository);

    await provider.run(row.id, 'hi', {
      model: 'claude:gpt-5.6-sol',
      workspace: dataDir,
    });

    expect(sessions.findById(row.id)?.status).toBe('ERROR');
    const errorEvent = events.list(row.id, 0).find((e) => e.type === 'error');
    expect(JSON.stringify(errorEvent?.payload ?? {})).toMatch(/offline|ECONNREFUSED/i);
  });

  it('lists Codex-sub models under Claude when the bridge is healthy', async () => {
    settings.set('NUNCIO_CLIPROXY_ENABLED', '1');
    settings.set('NUNCIO_CLIPROXY_API_KEY', 'bridge-secret');
    bridge.fetchImpl = stubFetch({
      data: [{ id: 'gpt-5.6-sol', display_name: 'GPT 5.6 Sol', owned_by: 'openai' }],
    });

    const catalog = await provider.listModels();
    const group = catalog[0]?.groups?.find((g) => g.id === 'codex-sub');
    expect(group?.models.some((m) => m.id === 'claude:gpt-5.6-sol')).toBe(true);
    expect(group?.models[0]?.badge).toBe('Codex sub');
  });
});
