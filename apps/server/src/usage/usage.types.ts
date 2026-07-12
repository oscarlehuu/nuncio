/** Providers that expose a first-party subscription quota probe in v1. */
export type UsageProviderId = 'claude' | 'codex' | 'cursor';

export const USAGE_PROVIDER_IDS: readonly UsageProviderId[] = ['claude', 'codex', 'cursor'];

export type UsageStatus = 'ok' | 'needs-auth' | 'unsupported' | 'error';

export interface UsageLimitDto {
  window: string;
  usedPercent?: number;
  resetsAt?: string;
  windowDurationMins?: number;
}

export interface UsageLineDto {
  label: string;
  value: string;
  subtitle?: string;
}

export interface UsageSnapshotDto {
  provider: UsageProviderId;
  updatedAt: string;
  limits: UsageLimitDto[];
  usageLines: UsageLineDto[];
  source: string;
  status: UsageStatus;
  planName?: string;
  detail?: string;
}

export interface ProviderUsageContext {
  readonly homeDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly nowMs: number;
}

export interface UsageHistoryDayDto {
  date: string;
  claude: number;
  codex: number;
  cursor: number;
}

export interface UsageHistoryDto {
  days: UsageHistoryDayDto[];
  totals: { claude: number; codex: number; cursor: number };
  estimatedUsdTotals: { claude: number; codex: number; cursor: number };
  updatedAt: string;
}

export interface ProviderUsageFetcher {
  readonly provider: UsageProviderId;
  /** Resolve credentials and fetch live usage. Never throws. */
  fetch(ctx: ProviderUsageContext): Promise<UsageSnapshotDto>;
}
