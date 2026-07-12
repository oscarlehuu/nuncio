import { apiFetch } from './http';

export type UsageProviderId = 'claude' | 'codex' | 'cursor';

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

export async function fetchProviderUsage(options?: {
  forceRefresh?: boolean;
}): Promise<UsageSnapshotDto[]> {
  const qs = options?.forceRefresh ? '?forceRefresh=true' : '';
  const res = await apiFetch(`/api/usage${qs}`);
  if (!res.ok) {
    throw new Error('Failed to fetch provider usage');
  }
  return res.json();
}

export async function fetchProviderUsageSnapshot(
  provider: UsageProviderId,
  options?: { forceRefresh?: boolean },
): Promise<UsageSnapshotDto> {
  const qs = options?.forceRefresh ? '?forceRefresh=true' : '';
  const res = await apiFetch(`/api/usage/${provider}${qs}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${provider} usage`);
  }
  return res.json();
}

export async function fetchUsageHistory(options?: {
  days?: number;
  forceRefresh?: boolean;
}): Promise<UsageHistoryDto> {
  const params = new URLSearchParams();
  if (options?.days != null) params.set('days', String(options.days));
  if (options?.forceRefresh) params.set('forceRefresh', 'true');
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await apiFetch(`/api/usage/history${qs}`);
  if (!res.ok) {
    throw new Error('Failed to fetch usage history');
  }
  return res.json();
}
