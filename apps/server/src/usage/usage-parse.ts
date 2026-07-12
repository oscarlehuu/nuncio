import type {
  UsageLimitDto,
  UsageLineDto,
  UsageProviderId,
  UsageSnapshotDto,
  UsageStatus,
} from './usage.types';

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function clampPercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(100, Math.max(0, value));
}

export function isoFromUnixSeconds(value: unknown): string | undefined {
  const seconds = asFiniteNumber(value);
  if (seconds === undefined || seconds <= 0) {
    return undefined;
  }
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function isoFromUnixMillis(value: unknown): string | undefined {
  const millis = asFiniteNumber(value);
  if (millis === undefined || millis <= 0) {
    return undefined;
  }
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function isoFromString(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) {
    return undefined;
  }
  const millis = Date.parse(text);
  return Number.isNaN(millis) ? undefined : new Date(millis).toISOString();
}

export function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(amount);
}

const NEEDS_AUTH_DETAIL: Record<UsageProviderId, string> = {
  claude: 'Sign in with `claude` to see usage.',
  codex: 'Sign in with `codex login` to see usage.',
  cursor: 'Open Cursor and sign in to see usage.',
};

export interface SnapshotInput {
  provider: UsageProviderId;
  nowMs: number;
  status: UsageStatus;
  source: string;
  limits?: ReadonlyArray<UsageLimitDto>;
  usageLines?: ReadonlyArray<UsageLineDto>;
  planName?: string;
  detail?: string;
}

export function buildSnapshot(input: SnapshotInput): UsageSnapshotDto {
  return {
    provider: input.provider,
    updatedAt: new Date(input.nowMs).toISOString(),
    limits: [...(input.limits ?? [])],
    usageLines: [...(input.usageLines ?? [])],
    source: input.source,
    status: input.status,
    ...(input.planName ? { planName: input.planName } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
  };
}

export function needsAuthSnapshot(
  provider: UsageProviderId,
  nowMs: number,
  source: string,
): UsageSnapshotDto {
  return buildSnapshot({
    provider,
    nowMs,
    status: 'needs-auth',
    source,
    detail: NEEDS_AUTH_DETAIL[provider],
  });
}

export function unsupportedSnapshot(
  provider: UsageProviderId,
  nowMs: number,
  source: string,
  detail: string,
): UsageSnapshotDto {
  return buildSnapshot({ provider, nowMs, status: 'unsupported', source, detail });
}

export function errorSnapshot(
  provider: UsageProviderId,
  nowMs: number,
  source: string,
  detail: string,
): UsageSnapshotDto {
  return buildSnapshot({ provider, nowMs, status: 'error', source, detail });
}
