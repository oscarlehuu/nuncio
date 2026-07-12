import type { UsageLimitDto, UsageProviderId, UsageSnapshotDto } from './usage-api';
import { deriveUsagePace, type UsagePaceSummary } from './usage-pace';
import type { UsagePercentMode } from './usage-percent-preference';
import {
  resolveUsageProvider,
  usageNeedsAuthHint,
  usageSignInCommand,
} from '@nuncio/core/usage-resolve';

export { resolveUsageProvider, usageNeedsAuthHint, usageSignInCommand };

/** Providers that can show a subscription quota chip. */
export function isUsageProviderId(value: string | null | undefined): value is UsageProviderId {
  return value === 'claude' || value === 'codex' || value === 'cursor';
}

/** Prefer the shortest window with a usedPercent (Session over Weekly). */
export function primaryUsageLimit(snapshot: UsageSnapshotDto | null | undefined): UsageLimitDto | null {
  if (!snapshot || snapshot.status !== 'ok' || snapshot.limits.length === 0) {
    return null;
  }
  const withPercent = snapshot.limits.filter((limit) => typeof limit.usedPercent === 'number');
  if (withPercent.length === 0) {
    return snapshot.limits[0] ?? null;
  }
  return (
    withPercent.find((limit) => /session|5h|current|total/i.test(limit.window)) ??
    withPercent.reduce((best, limit) =>
      (limit.windowDurationMins ?? Number.POSITIVE_INFINITY) <
      (best.windowDurationMins ?? Number.POSITIVE_INFINITY)
        ? limit
        : best,
    )
  );
}

export function remainingPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

/** Percent shown in the UI for the selected mode (used vs left). */
export function displayPercent(usedPercent: number, mode: UsagePercentMode): number {
  const value = mode === 'left' ? remainingPercent(usedPercent) : usedPercent;
  return Math.round(Math.min(100, Math.max(0, value)));
}

/**
 * Ring fill always tracks *used* pressure (higher = more consumed),
 * regardless of whether the label shows used or left.
 */
export function ringFillPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, usedPercent));
}

export function formatPercentLabel(
  usedPercent: number,
  mode: UsagePercentMode,
  options?: { notStarted?: boolean },
): string {
  if (options?.notStarted) {
    return 'Not started';
  }
  const n = displayPercent(usedPercent, mode);
  return mode === 'left' ? `${n}% left` : `${n}% used`;
}

/** Session-style windows at 0% used → OpenUsage "Not started". */
export function isNotStartedLimit(limit: UsageLimitDto): boolean {
  return (
    typeof limit.usedPercent === 'number' &&
    limit.usedPercent === 0 &&
    /^(session|5h)$/i.test(limit.window.trim())
  );
}

export function inferWindowDurationMins(limit: UsageLimitDto): number | undefined {
  if (typeof limit.windowDurationMins === 'number' && limit.windowDurationMins > 0) {
    return limit.windowDurationMins;
  }
  const label = limit.window.toLowerCase();
  if (/session|5h|spark(?!\s*weekly)/.test(label)) return 300;
  if (/week|7d/.test(label)) return 10_080;
  if (/total|current|auto|api|month/.test(label)) return 43_200; // ~30d billing heuristic
  return undefined;
}

export function paceForLimit(
  limit: UsageLimitDto,
  nowMs = Date.now(),
): UsagePaceSummary | null {
  if (typeof limit.usedPercent !== 'number' || !limit.resetsAt) {
    return null;
  }
  const duration = inferWindowDurationMins(limit);
  if (duration === undefined) return null;
  return deriveUsagePace({
    nowMs,
    remainingPercent: remainingPercent(limit.usedPercent),
    resetsAt: limit.resetsAt,
    windowDurationMins: duration,
  });
}

export function formatResetCountdown(resetsAt: string, nowMs = Date.now()): string {
  const target = Date.parse(resetsAt);
  if (Number.isNaN(target)) {
    return '';
  }
  const deltaMs = Math.max(0, target - nowMs);
  const totalMins = Math.round(deltaMs / 60_000);
  if (totalMins < 60) {
    return `${Math.max(1, totalMins)}m`;
  }
  const hours = Math.floor(totalMins / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function formatUpdatedAgo(updatedAt: string, nowMs = Date.now()): string {
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) {
    return '';
  }
  const mins = Math.max(0, Math.floor((nowMs - then) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Newest successful snapshot timestamp across providers (shared footer). */
export function freshestUpdatedAt(snapshots: ReadonlyArray<UsageSnapshotDto>): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const snap of snapshots) {
    if (snap.status !== 'ok' || !snap.updatedAt) continue;
    const ms = Date.parse(snap.updatedAt);
    if (!Number.isNaN(ms) && ms > bestMs) {
      bestMs = ms;
      best = snap.updatedAt;
    }
  }
  return best;
}

export function pinActiveProvider(
  snapshots: UsageSnapshotDto[],
  active: string | null | undefined,
): UsageSnapshotDto[] {
  if (!isUsageProviderId(active)) {
    return snapshots;
  }
  const activeSnap = snapshots.find((s) => s.provider === active);
  if (!activeSnap) {
    return snapshots;
  }
  return [activeSnap, ...snapshots.filter((s) => s.provider !== active)];
}
