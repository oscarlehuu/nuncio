import { describe, expect, it } from 'vitest';
import { subscriptionBridgeSubtitle, type SubscriptionBridgeStatus } from './subscription-bridge-api';

function status(over: Partial<SubscriptionBridgeStatus> = {}): SubscriptionBridgeStatus {
  return {
    enabled: true,
    online: true,
    baseUrl: 'http://127.0.0.1:8317',
    hasApiKey: true,
    accounts: { claude: true, codex: true },
    modelCount: 2,
    error: null,
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
    expect(subscriptionBridgeSubtitle(status())).toBe('Online · Claude + Codex');
  });

  it('surfaces offline errors', () => {
    expect(
      subscriptionBridgeSubtitle(status({ online: false, error: 'ECONNREFUSED' })),
    ).toBe('Offline · ECONNREFUSED');
  });
});
