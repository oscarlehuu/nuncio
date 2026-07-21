/** Where a bridge-listed model bills when routed through CLIProxyAPI. */
export type SubscriptionBridgeSource = 'claude-sub' | 'codex-sub' | 'other';

/** How Nuncio relates to the CLIProxyAPI process. */
export type SubscriptionBridgeMode = 'external' | 'managed';

export interface SubscriptionBridgeModel {
  /** Upstream model id as clients should send (e.g. gpt-5.6-sol). */
  id: string;
  displayName: string;
  source: SubscriptionBridgeSource;
  ownedBy?: string;
}

export interface SubscriptionBridgeManagedDto {
  running: boolean;
  pid: number | null;
  configPath: string | null;
  port: number | null;
}

export interface SubscriptionBridgeStatusDto {
  enabled: boolean;
  online: boolean;
  /** `external` = user's own CLIProxyAPI; `managed` = Nuncio-supervised cliproxyapi-nuncio. */
  mode: SubscriptionBridgeMode;
  baseUrl: string;
  hasApiKey: boolean;
  accounts: {
    claude: boolean;
    codex: boolean;
  };
  modelCount: number;
  error: string | null;
  managed: SubscriptionBridgeManagedDto;
  /** Shell one-liners for first-time OAuth (desktop/local). */
  loginHints: {
    claude: string;
    codex: string;
  };
}

export interface AdoptExternalDto {
  configPath: string;
  apiKeyIndex?: number;
}

export interface MigrateManagedDto {
  configPath: string;
  /** Listen port for the Nuncio-managed process (default 18317). */
  port?: number;
}

export interface InitManagedDto {
  port?: number;
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
