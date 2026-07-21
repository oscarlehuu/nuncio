/** Where a bridge-listed model bills when routed through CLIProxy. */
export type SubscriptionBridgeSource = 'claude-sub' | 'codex-sub' | 'other';

export interface SubscriptionBridgeModel {
  /** Upstream model id as clients should send (e.g. gpt-5.6-sol). */
  id: string;
  displayName: string;
  source: SubscriptionBridgeSource;
  ownedBy?: string;
}

export interface SubscriptionBridgeStatusDto {
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
  /** Shell one-liners for first-time OAuth (desktop/local). */
  loginHints: {
    claude: string;
    codex: string;
  };
}

export interface SubscriptionBridgeClaudeCodeEnvDto {
  enabled: boolean;
  online: boolean;
  /** Ready-to-paste shell exports for an external `claude` session. */
  exports: string;
  /** Same values as structured fields for UI copy. */
  env: {
    ANTHROPIC_BASE_URL: string;
    ANTHROPIC_AUTH_TOKEN: string;
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: string;
  };
}
