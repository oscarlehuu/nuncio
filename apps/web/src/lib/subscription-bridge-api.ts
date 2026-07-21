import { withBase } from './api-base';

export interface SubscriptionBridgeStatus {
  enabled: boolean;
  online: boolean;
  baseUrl: string;
  hasApiKey: boolean;
  accounts: {
    claude: boolean;
    codex: boolean;
  };
  modelCount: number;
  error: string | null;
  loginHints: {
    claude: string;
    codex: string;
  };
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

export async function fetchSubscriptionBridgeStatus(): Promise<SubscriptionBridgeStatus> {
  const res = await fetch(withBase('/api/subscription-bridge/status'));
  if (!res.ok) throw new Error(await responseMessage(res, 'Failed to load Subscription bridge status'));
  return res.json();
}

export async function refreshSubscriptionBridgeStatus(): Promise<SubscriptionBridgeStatus> {
  const res = await fetch(withBase('/api/subscription-bridge/refresh'), { method: 'POST' });
  if (!res.ok) throw new Error(await responseMessage(res, 'Failed to refresh Subscription bridge'));
  return res.json();
}

export async function fetchSubscriptionBridgeClaudeCodeEnv(): Promise<SubscriptionBridgeClaudeCodeEnv> {
  // POST: explicit copy action — response includes the CLIProxy API key for paste into a local shell.
  const res = await fetch(withBase('/api/subscription-bridge/claude-code-env'), { method: 'POST' });
  if (!res.ok) throw new Error(await responseMessage(res, 'Failed to load Claude Code env'));
  return res.json();
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

/** One-line subtitle for Settings → Providers → Subscription bridge. */
export function subscriptionBridgeSubtitle(status: SubscriptionBridgeStatus | null): string {
  if (!status) return 'Local CLIProxy for cross-subscription models';
  if (!status.enabled) return 'Disabled · enable to route Claude ↔ Codex subscriptions';
  if (!status.online) {
    return status.error ? `Offline · ${status.error}` : 'Offline · start CLIProxy';
  }
  const parts: string[] = ['Online'];
  if (status.accounts.claude && status.accounts.codex) parts.push('Claude + Codex');
  else if (status.accounts.codex) parts.push('Codex only');
  else if (status.accounts.claude) parts.push('Claude only');
  else parts.push('no OAuth accounts detected');
  return parts.join(' · ');
}
