import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchSubscriptionBridgeClaudeCodeEnv,
  fetchSubscriptionBridgeStatus,
  refreshSubscriptionBridgeStatus,
  subscriptionBridgeSubtitle,
  type SubscriptionBridgeStatus,
} from './subscription-bridge-api';

function status(over: Partial<SubscriptionBridgeStatus> = {}): SubscriptionBridgeStatus {
  return {
    enabled: true,
    online: true,
    mode: 'external',
    baseUrl: 'http://127.0.0.1:8317',
    hasApiKey: true,
    accounts: { claude: true, codex: true },
    modelCount: 2,
    error: null,
    managed: { running: false, pid: null, configPath: null, port: null },
    loginHints: { claude: 'cli --claude-login', codex: 'cli --codex-login' },
    ...over,
  };
}

describe('subscriptionBridgeSubtitle', () => {
  it('describes disabled state', () => {
    expect(subscriptionBridgeSubtitle(status({ enabled: false, online: false }))).toMatch(
      /Disabled/i,
    );
  });

  it('describes online Claude + Codex', () => {
    expect(subscriptionBridgeSubtitle(status())).toBe('Online · External · Claude + Codex');
  });

  it('describes Codex-only and Claude-only accounts', () => {
    expect(
      subscriptionBridgeSubtitle(status({ accounts: { claude: false, codex: true } })),
    ).toBe('Online · External · Codex only');
    expect(
      subscriptionBridgeSubtitle(status({ accounts: { claude: true, codex: false } })),
    ).toBe('Online · External · Claude only');
  });

  it('surfaces offline errors with mode', () => {
    expect(
      subscriptionBridgeSubtitle(status({ online: false, error: 'ECONNREFUSED' })),
    ).toBe('Offline · External · ECONNREFUSED');
  });

  it('falls back when status is null', () => {
    expect(subscriptionBridgeSubtitle(null)).toMatch(/Local CLIProxyAPI/i);
  });
});

describe('subscription-bridge-api fetch helpers', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => status(),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs status', async () => {
    const dto = await fetchSubscriptionBridgeStatus();
    expect(dto.online).toBe(true);
    expect(fetch).toHaveBeenCalledWith('/api/subscription-bridge/status');
  });

  it('POSTs refresh', async () => {
    await refreshSubscriptionBridgeStatus();
    expect(fetch).toHaveBeenCalledWith('/api/subscription-bridge/refresh', { method: 'POST' });
  });

  it('POSTs Claude Code env export (never GET)', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        enabled: true,
        online: true,
        exports: 'export ANTHROPIC_BASE_URL=http://127.0.0.1:8317',
        env: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317',
          ANTHROPIC_AUTH_TOKEN: 'secret',
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
        },
      }),
    } as Response);

    await fetchSubscriptionBridgeClaudeCodeEnv();
    expect(fetch).toHaveBeenCalledWith('/api/subscription-bridge/claude-code-env', {
      method: 'POST',
    });
  });

  it('throws a useful message when the API returns an error body', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({ message: 'bridge down' }),
    } as Response);

    await expect(fetchSubscriptionBridgeStatus()).rejects.toThrow('bridge down');
  });
});
