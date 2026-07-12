import nodePath from 'node:path';
import { decodeJwtExpMs, readKeychainPassword } from '../usage-credentials';
import { fetchJson, isAuthFailureStatus } from '../usage-http';
import {
  asFiniteNumber,
  asRecord,
  asString,
  buildSnapshot,
  clampPercent,
  errorSnapshot,
  formatUsd,
  isoFromUnixMillis,
  needsAuthSnapshot,
  titleCase,
} from '../usage-parse';
import { readItemTableValues } from '../usage-sqlite';
import type { ProviderUsageContext, ProviderUsageFetcher, UsageLimitDto, UsageLineDto } from '../usage.types';

const SOURCE = 'cursor-dashboard';
const USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const CREDITS_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCreditGrantsBalance';
const KEYCHAIN_SERVICE = 'cursor-access-token';
const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';
const PLAN_KEY = 'cursorAuth/stripeMembershipType';

interface CursorAuth {
  accessToken: string;
  plan?: string;
}

function stateDbPaths(ctx: ProviderUsageContext): string[] {
  const segments = ['Cursor', 'User', 'globalStorage', 'state.vscdb'];
  if (ctx.platform === 'darwin') {
    return [nodePath.join(ctx.homeDir, 'Library', 'Application Support', ...segments)];
  }
  if (ctx.platform === 'win32' && ctx.env.APPDATA) {
    return [nodePath.join(ctx.env.APPDATA, ...segments)];
  }
  return [nodePath.join(ctx.homeDir, '.config', ...segments)];
}

function resolveCursorAuth(ctx: ProviderUsageContext): CursorAuth | null {
  for (const dbPath of stateDbPaths(ctx)) {
    const values = readItemTableValues({ dbPath, keys: [ACCESS_TOKEN_KEY, PLAN_KEY] });
    const accessToken = asString(values[ACCESS_TOKEN_KEY]);
    if (accessToken) {
      const plan = asString(values[PLAN_KEY]);
      return { accessToken, ...(plan ? { plan } : {}) };
    }
  }

  // Keychain is async in the helper API — resolve via a sync-looking bridge below in fetch().
  return null;
}

async function resolveCursorAuthAsync(ctx: ProviderUsageContext): Promise<CursorAuth | null> {
  const fromDb = resolveCursorAuth(ctx);
  if (fromDb) {
    return fromDb;
  }

  const keychain = await readKeychainPassword({
    service: KEYCHAIN_SERVICE,
    platform: ctx.platform,
  });
  const token = keychain ? asString(keychain) : undefined;
  return token ? { accessToken: token } : null;
}

function cursorHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Connect-Protocol-Version': '1',
  };
}

export function parseCursorUsage(input: {
  usage: unknown;
  credits?: unknown;
  planName?: string;
  nowMs: number;
}) {
  const usage = asRecord(input.usage);
  const planUsage = asRecord(usage?.planUsage);
  const spendLimit = asRecord(usage?.spendLimitUsage);
  const limits: UsageLimitDto[] = [];
  const usageLines: UsageLineDto[] = [];

  const totalPercent = clampPercent(asFiniteNumber(planUsage?.totalPercentUsed));
  const resetsAt = isoFromUnixMillis(usage?.billingCycleEnd);
  if (totalPercent !== undefined || resetsAt) {
    limits.push({
      window: 'Total',
      ...(totalPercent !== undefined ? { usedPercent: totalPercent } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  const autoPercent = clampPercent(asFiniteNumber(planUsage?.autoPercentUsed));
  if (autoPercent !== undefined) {
    limits.push({
      window: 'Auto',
      usedPercent: autoPercent,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  const apiPercent = clampPercent(asFiniteNumber(planUsage?.apiPercentUsed));
  if (apiPercent !== undefined) {
    limits.push({
      window: 'API',
      usedPercent: apiPercent,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  const individualLimit = asFiniteNumber(spendLimit?.individualLimit);
  const individualRemaining = asFiniteNumber(spendLimit?.individualRemaining);
  if (individualLimit !== undefined && individualLimit > 0) {
    const used =
      individualRemaining !== undefined
        ? Math.max(0, individualLimit - individualRemaining)
        : undefined;
    usageLines.push({
      label: 'On-demand',
      value:
        used !== undefined
          ? `${formatUsd(used / 100)} of ${formatUsd(individualLimit / 100)}`
          : `${formatUsd(individualLimit / 100)} limit`,
    });
  }

  const credits = asRecord(input.credits);
  if (credits && credits.hasCreditGrants !== false) {
    const totalCents = asFiniteNumber(credits.totalCents);
    const usedCents = asFiniteNumber(credits.usedCents);
    if (totalCents !== undefined && totalCents > 0) {
      const remaining = usedCents !== undefined ? Math.max(0, totalCents - usedCents) : totalCents;
      usageLines.push({
        label: 'Credits',
        value: `${formatUsd(remaining / 100)} of ${formatUsd(totalCents / 100)} remaining`,
      });
    }
  }

  return buildSnapshot({
    provider: 'cursor',
    nowMs: input.nowMs,
    status: 'ok',
    source: SOURCE,
    limits,
    usageLines,
    ...(input.planName ? { planName: input.planName } : {}),
  });
}

export const cursorUsageFetcher: ProviderUsageFetcher = {
  provider: 'cursor',
  async fetch(ctx) {
    const auth = await resolveCursorAuthAsync(ctx);
    if (!auth) {
      return needsAuthSnapshot('cursor', ctx.nowMs, SOURCE);
    }
    const expMs = decodeJwtExpMs(auth.accessToken);
    if (expMs !== null && expMs <= ctx.nowMs) {
      return needsAuthSnapshot('cursor', ctx.nowMs, SOURCE);
    }

    try {
      const usageResult = await fetchJson({
        url: USAGE_URL,
        method: 'POST',
        headers: cursorHeaders(auth.accessToken),
        body: {},
      });
      if (isAuthFailureStatus(usageResult.status)) {
        return needsAuthSnapshot('cursor', ctx.nowMs, SOURCE);
      }
      if (!usageResult.ok) {
        return errorSnapshot(
          'cursor',
          ctx.nowMs,
          SOURCE,
          `Cursor usage request failed (${usageResult.status}).`,
        );
      }

      let creditsJson: unknown;
      try {
        const creditsResult = await fetchJson({
          url: CREDITS_URL,
          method: 'POST',
          headers: cursorHeaders(auth.accessToken),
          body: {},
        });
        if (creditsResult.ok) {
          creditsJson = creditsResult.json;
        }
      } catch {
        creditsJson = undefined;
      }

      return parseCursorUsage({
        usage: usageResult.json,
        credits: creditsJson,
        nowMs: ctx.nowMs,
        ...(auth.plan ? { planName: titleCase(auth.plan) } : {}),
      });
    } catch {
      return errorSnapshot('cursor', ctx.nowMs, SOURCE, 'Could not reach the Cursor dashboard.');
    }
  },
};
