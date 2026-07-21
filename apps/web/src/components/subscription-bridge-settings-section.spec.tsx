import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SubscriptionBridgeSettingsSection } from './subscription-bridge-settings-section';
import type { SubscriptionBridgeStatus } from '../lib/subscription-bridge-api';

const refreshSubscriptionBridgeStatus = vi.fn();
const fetchSubscriptionBridgeClaudeCodeEnv = vi.fn();
const discoverSubscriptionBridgeInstalls = vi.fn();
const initManagedSubscriptionBridge = vi.fn();

vi.mock('../lib/subscription-bridge-api', () => ({
  refreshSubscriptionBridgeStatus: (...args: unknown[]) => refreshSubscriptionBridgeStatus(...args),
  fetchSubscriptionBridgeClaudeCodeEnv: (...args: unknown[]) =>
    fetchSubscriptionBridgeClaudeCodeEnv(...args),
  discoverSubscriptionBridgeInstalls: (...args: unknown[]) =>
    discoverSubscriptionBridgeInstalls(...args),
  adoptExternalSubscriptionBridge: vi.fn(),
  migrateManagedSubscriptionBridge: vi.fn(),
  initManagedSubscriptionBridge: (...args: unknown[]) => initManagedSubscriptionBridge(...args),
  startManagedSubscriptionBridge: vi.fn(),
  stopManagedSubscriptionBridge: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function status(over: Partial<SubscriptionBridgeStatus> = {}): SubscriptionBridgeStatus {
  return {
    enabled: true,
    online: true,
    mode: 'external',
    baseUrl: 'http://127.0.0.1:8317',
    hasApiKey: true,
    accounts: { claude: true, codex: true },
    modelCount: 4,
    error: null,
    managed: { running: false, pid: null, configPath: null, port: null },
    loginHints: {
      claude: 'cli-proxy-api --claude-login',
      codex: 'cli-proxy-api --codex-login',
    },
    ...over,
  };
}

describe('SubscriptionBridgeSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discoverSubscriptionBridgeInstalls.mockResolvedValue([]);
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('renders login hints and refreshes health on Check health', async () => {
    const onStatus = vi.fn();
    const next = status({ online: false, error: 'ECONNREFUSED' });
    refreshSubscriptionBridgeStatus.mockResolvedValue(next);

    render(<SubscriptionBridgeSettingsSection status={status()} onStatus={onStatus} />);

    expect(screen.getByText(/cli-proxy-api --claude-login/)).toBeInTheDocument();
    expect(screen.getByText(/cli-proxy-api --codex-login/)).toBeInTheDocument();
    expect(screen.getByText(/1\. Existing CLIProxyAPI/)).toBeInTheDocument();
    expect(screen.queryByText(/Migrate → managed/)).not.toBeInTheDocument();
    expect(screen.getByText(/2\. Fresh managed/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Check Subscription bridge health/i }));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(next));
    expect(refreshSubscriptionBridgeStatus).toHaveBeenCalledTimes(1);
  });

  it('initializes a fresh managed CLIProxyAPI', async () => {
    const onStatus = vi.fn();
    const next = status({
      mode: 'managed',
      managed: {
        running: true,
        pid: 42,
        configPath: '/tmp/cliproxyapi/config.yaml',
        port: 18317,
      },
    });
    initManagedSubscriptionBridge.mockResolvedValue(next);

    render(<SubscriptionBridgeSettingsSection status={status()} onStatus={onStatus} />);
    await userEvent.click(screen.getByRole('button', { name: /Initialize managed/i }));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(next));
    expect(initManagedSubscriptionBridge).toHaveBeenCalledTimes(1);
  });

  it('copies Claude Code env exports to the clipboard', async () => {
    fetchSubscriptionBridgeClaudeCodeEnv.mockResolvedValue({
      enabled: true,
      online: true,
      exports: "export ANTHROPIC_BASE_URL=http://127.0.0.1:8317\nexport ANTHROPIC_AUTH_TOKEN=secret",
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317',
        ANTHROPIC_AUTH_TOKEN: 'secret',
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      },
    });

    render(<SubscriptionBridgeSettingsSection status={status()} onStatus={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /Copy Claude Code env/i }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('ANTHROPIC_BASE_URL'),
      ),
    );
  });

  it('surfaces an error toast when the API key is missing on copy', async () => {
    const { toast } = await import('sonner');
    fetchSubscriptionBridgeClaudeCodeEnv.mockResolvedValue({
      enabled: true,
      online: false,
      exports: 'export ANTHROPIC_BASE_URL=http://127.0.0.1:8317\nexport ANTHROPIC_AUTH_TOKEN=',
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317',
        ANTHROPIC_AUTH_TOKEN: '',
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      },
    });

    render(<SubscriptionBridgeSettingsSection status={status({ hasApiKey: false })} onStatus={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Copy Claude Code env/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Set the CLIProxyAPI API key before copying env'),
    );
  });
});
