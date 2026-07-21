import { withBase } from './api-base';

export type SubscriptionBridgeMode = 'external' | 'managed';

export interface SubscriptionBridgeStatus {
  enabled: boolean;
  online: boolean;
  mode: SubscriptionBridgeMode;
  baseUrl: string;
  hasApiKey: boolean;
  accounts: {
    claude: boolean;
    codex: boolean;
  };
  modelCount: number;
  error: string | null;
  managed: {
    running: boolean;
    pid: number | null;
    configPath: string | null;
    port: number | null;
  };
  loginHints: {
    claude: string;
    codex: string;
  };
}

export interface SubscriptionBridgeDiscoveryInstall {
  configPath: string;
  port: number | null;
  authDir: string | null;
  binaryPath: string | null;
  baseUrl: string | null;
  accounts: { claude: boolean; codex: boolean };
  apiKeys: Array<{ index: number; preview: string }>;
}

export interface SubscriptionBridgeClaudeCodeEnv {
  enabled: boolean;
  online: boolean;
  exports: string;
  env: {
    ANTHROPIC_BASE_URL: string;
    ANTHROPIC_AUTH_TOKEN: string;
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: string;
  };
}

async function parseJson<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) throw new Error(await responseMessage(res, fallback));
  return res.json() as Promise<T>;
}

export async function fetchSubscriptionBridgeStatus(): Promise<SubscriptionBridgeStatus> {
  const res = await fetch(withBase('/api/subscription-bridge/status'));
  return parseJson(res, 'Failed to load Subscription bridge status');
}

export async function refreshSubscriptionBridgeStatus(): Promise<SubscriptionBridgeStatus> {
  const res = await fetch(withBase('/api/subscription-bridge/refresh'), { method: 'POST' });
  return parseJson(res, 'Failed to refresh Subscription bridge');
}

export async function discoverSubscriptionBridgeInstalls(): Promise<SubscriptionBridgeDiscoveryInstall[]> {
  const res = await fetch(withBase('/api/subscription-bridge/discover'));
  const body = await parseJson<{ installs: SubscriptionBridgeDiscoveryInstall[] }>(
    res,
    'Failed to discover CLIProxyAPI installs',
  );
  return body.installs ?? [];
}

export async function adoptExternalSubscriptionBridge(body: {
  configPath: string;
  apiKeyIndex?: number;
}): Promise<SubscriptionBridgeStatus> {
  const res = await fetch(withBase('/api/subscription-bridge/adopt-external'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseJson(res, 'Failed to connect external CLIProxyAPI');
}

export async function migrateManagedSubscriptionBridge(body: {
  configPath: string;
  port?: number;
}): Promise<SubscriptionBridgeStatus> {
  const res = await fetch(withBase('/api/subscription-bridge/migrate-managed'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseJson(res, 'Failed to migrate CLIProxyAPI into Nuncio');
}

export async function initManagedSubscriptionBridge(body: {
  port?: number;
} = {}): Promise<SubscriptionBridgeStatus> {
  const res = await fetch(withBase('/api/subscription-bridge/init-managed'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseJson(res, 'Failed to initialize managed CLIProxyAPI');
}

export async function startManagedSubscriptionBridge(): Promise<SubscriptionBridgeStatus> {
  const res = await fetch(withBase('/api/subscription-bridge/managed/start'), { method: 'POST' });
  return parseJson(res, 'Failed to start managed CLIProxyAPI');
}

export async function stopManagedSubscriptionBridge(): Promise<SubscriptionBridgeStatus> {
  const res = await fetch(withBase('/api/subscription-bridge/managed/stop'), { method: 'POST' });
  return parseJson(res, 'Failed to stop managed CLIProxyAPI');
}

export async function fetchSubscriptionBridgeClaudeCodeEnv(): Promise<SubscriptionBridgeClaudeCodeEnv> {
  // POST: explicit copy action — response includes the CLIProxyAPI API key for paste into a local shell.
  const res = await fetch(withBase('/api/subscription-bridge/claude-code-env'), { method: 'POST' });
  return parseJson(res, 'Failed to load Claude Code env');
}

async function responseMessage(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { message?: unknown };
    return typeof payload.message === 'string' && payload.message.trim()
      ? payload.message.trim()
      : fallback;
  } catch {
    return fallback;
  }
}

/** One-line subtitle for Settings → Subscription bridge. */
export function subscriptionBridgeSubtitle(status: SubscriptionBridgeStatus | null): string {
  if (!status) return 'Local CLIProxyAPI for cross-subscription models';
  const modeLabel = status.mode === 'managed' ? 'Managed' : 'External';
  if (!status.enabled) return `Disabled · ${modeLabel} · enable to route Claude ↔ Codex subscriptions`;
  if (!status.online) {
    const detail = status.error ? status.error : 'start CLIProxyAPI';
    return `Offline · ${modeLabel} · ${detail}`;
  }
  const parts: string[] = ['Online', modeLabel];
  if (status.mode === 'managed' && status.managed.running) parts.push('process running');
  if (status.accounts.claude && status.accounts.codex) parts.push('Claude + Codex');
  else if (status.accounts.codex) parts.push('Codex only');
  else if (status.accounts.claude) parts.push('Claude only');
  else parts.push('no OAuth accounts detected');
  return parts.join(' · ');
}
