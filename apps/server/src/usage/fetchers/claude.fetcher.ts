import nodePath from 'node:path';
import {
  decodeKeychainJson,
  readJsonFile,
  readKeychainPassword,
  refreshOAuthAccessToken,
} from '../usage-credentials';
import { fetchJson, isAuthFailureStatus } from '../usage-http';
import {
  asFiniteNumber,
  asRecord,
  asString,
  buildSnapshot,
  clampPercent,
  errorSnapshot,
  formatUsd,
  isoFromString,
  needsAuthSnapshot,
  titleCase,
} from '../usage-parse';
import type { ProviderUsageContext, ProviderUsageFetcher, UsageLimitDto, UsageLineDto } from '../usage.types';

const SOURCE = 'claude-oauth-usage';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const SCOPES =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface ClaudeCreds {
  accessToken: string;
  refreshToken: string | undefined;
  expiresAtMs: number | undefined;
  subscriptionType: string | undefined;
  rateLimitTier: string | undefined;
  scopes: ReadonlyArray<string>;
}

function readScopes(oauth: Record<string, unknown> | null): ReadonlyArray<string> {
  if (Array.isArray(oauth?.scopes)) {
    return oauth.scopes.filter((scope): scope is string => typeof scope === 'string');
  }
  const scopeText = asString(oauth?.scope);
  return scopeText ? scopeText.split(/\s+/u).filter((scope) => scope.length > 0) : [];
}

function readClaudeCreds(record: Record<string, unknown> | null): ClaudeCreds | null {
  const oauth = asRecord(record?.claudeAiOauth);
  const accessToken = asString(oauth?.accessToken);
  if (!accessToken) {
    return null;
  }
  return {
    accessToken,
    refreshToken: asString(oauth?.refreshToken),
    expiresAtMs: asFiniteNumber(oauth?.expiresAt),
    subscriptionType: asString(oauth?.subscriptionType),
    rateLimitTier: asString(oauth?.rateLimitTier),
    scopes: readScopes(oauth),
  };
}

async function resolveClaudeCredCandidates(ctx: ProviderUsageContext): Promise<ClaudeCreds[]> {
  const candidates: ClaudeCreds[] = [];
  const paths: string[] = [];
  if (ctx.env.CLAUDE_CONFIG_DIR) {
    paths.push(nodePath.join(ctx.env.CLAUDE_CONFIG_DIR, '.credentials.json'));
  }
  paths.push(nodePath.join(ctx.homeDir, '.claude', '.credentials.json'));

  for (const path of paths) {
    const record = asRecord(await readJsonFile(path));
    const creds = readClaudeCreds(record);
    if (creds) {
      candidates.push(creds);
    }
  }

  const keychainAccount = asString(ctx.env.USER) ?? asString(ctx.env.LOGNAME);
  const keychain =
    keychainAccount !== undefined
      ? await readKeychainPassword({
          service: KEYCHAIN_SERVICE,
          account: keychainAccount,
          platform: ctx.platform,
        })
      : null;
  const keychainFallback =
    keychain ??
    (await readKeychainPassword({
      service: KEYCHAIN_SERVICE,
      platform: ctx.platform,
    }));
  if (keychainFallback) {
    const creds = readClaudeCreds(asRecord(decodeKeychainJson(keychainFallback)));
    if (creds) {
      candidates.push(creds);
    }
  }
  return candidates;
}

function hasProfileScope(creds: ClaudeCreds): boolean {
  return creds.scopes.length === 0 || creds.scopes.includes('user:profile');
}

function shouldRefreshClaudeCreds(creds: ClaudeCreds, nowMs: number): boolean {
  return creds.expiresAtMs !== undefined && creds.expiresAtMs <= nowMs + REFRESH_BUFFER_MS;
}

function claudePlanName(creds: ClaudeCreds): string | undefined {
  if (!creds.subscriptionType) {
    return undefined;
  }
  let name = titleCase(creds.subscriptionType);
  const tier = creds.rateLimitTier?.match(/(\d+x)/iu)?.[1];
  if (tier) {
    name += ` (${tier.toLowerCase()})`;
  }
  return name;
}

function applyRefreshedClaudeCreds(
  creds: ClaudeCreds,
  refreshed: { accessToken: string; refreshToken?: string; expiresAtMs?: number },
): ClaudeCreds {
  return {
    ...creds,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? creds.refreshToken,
    expiresAtMs: refreshed.expiresAtMs ?? creds.expiresAtMs,
  };
}

async function refreshClaudeCreds(creds: ClaudeCreds): Promise<ClaudeCreds | null> {
  if (!creds.refreshToken) {
    return null;
  }
  const refreshed = await refreshOAuthAccessToken({
    refreshUrl: REFRESH_URL,
    refreshToken: creds.refreshToken,
    clientId: CLIENT_ID,
    scope: SCOPES,
  });
  return refreshed ? applyRefreshedClaudeCreds(creds, refreshed) : null;
}

function fetchClaudeUsage(accessToken: string) {
  return fetchJson({
    url: USAGE_URL,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.69',
    },
  });
}

export function parseClaudeUsage(input: { json: unknown; nowMs: number; planName?: string }) {
  const root = asRecord(input.json);
  const limits: UsageLimitDto[] = [];
  const usageLines: UsageLineDto[] = [];

  const pushWindow = (label: string, windowValue: unknown, windowDurationMins: number): void => {
    const window = asRecord(windowValue);
    if (!window) {
      return;
    }
    const usedPercent = clampPercent(asFiniteNumber(window.utilization));
    const resetsAt = isoFromString(window.resets_at);
    if (usedPercent === undefined && !resetsAt) {
      return;
    }
    limits.push({
      window: label,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(resetsAt ? { resetsAt } : {}),
      windowDurationMins,
    });
  };

  pushWindow('Session', root?.five_hour, 300);
  pushWindow('Weekly', root?.seven_day, 10_080);
  pushWindow('Sonnet', root?.seven_day_sonnet, 10_080);
  pushWindow('Opus', root?.seven_day_opus, 10_080);

  // Model-scoped windows (e.g. Fable) arrive as a `limits` array on some plans.
  if (Array.isArray(root?.limits)) {
    for (const entry of root.limits) {
      const record = asRecord(entry);
      const name = asString(record?.name) ?? asString(record?.label);
      if (!name) continue;
      const label = titleCase(name);
      if (limits.some((limit) => limit.window === label)) continue;
      pushWindow(label, record, 10_080);
    }
  }

  const extra = asRecord(root?.extra_usage);
  if (extra && extra.is_enabled !== false) {
    const usedCredits = asFiniteNumber(extra.used_credits);
    const monthlyLimit = asFiniteNumber(extra.monthly_limit);
    if (usedCredits !== undefined) {
      const usedUsd = formatUsd(usedCredits / 100);
      const value =
        monthlyLimit && monthlyLimit > 0
          ? `${usedUsd} of ${formatUsd(monthlyLimit / 100)}`
          : `${usedUsd} spent`;
      usageLines.push({ label: 'Extra usage', value });
    }
  }

  return buildSnapshot({
    provider: 'claude',
    nowMs: input.nowMs,
    status: 'ok',
    source: SOURCE,
    limits,
    usageLines,
    ...(input.planName ? { planName: input.planName } : {}),
  });
}

export const claudeUsageFetcher: ProviderUsageFetcher = {
  provider: 'claude',
  async fetch(ctx) {
    const candidates = await resolveClaudeCredCandidates(ctx);
    if (candidates.length === 0) {
      return needsAuthSnapshot('claude', ctx.nowMs, SOURCE);
    }

    let inferenceOnlySnapshot: ReturnType<typeof buildSnapshot> | null = null;
    let lastErrorSnapshot: ReturnType<typeof errorSnapshot> | null = null;

    for (const creds of candidates) {
      if (!hasProfileScope(creds)) {
        const planName = claudePlanName(creds);
        inferenceOnlySnapshot = buildSnapshot({
          provider: 'claude',
          nowMs: ctx.nowMs,
          status: 'ok',
          source: SOURCE,
          ...(planName ? { planName } : {}),
        });
        continue;
      }

      let activeCreds = creds;
      if (shouldRefreshClaudeCreds(activeCreds, ctx.nowMs)) {
        const refreshed = await refreshClaudeCreds(activeCreds);
        if (refreshed) {
          activeCreds = refreshed;
        } else if (activeCreds.expiresAtMs !== undefined && activeCreds.expiresAtMs <= ctx.nowMs) {
          continue;
        }
      }

      try {
        let result = await fetchClaudeUsage(activeCreds.accessToken);
        if (isAuthFailureStatus(result.status) && activeCreds.refreshToken) {
          const refreshed = await refreshClaudeCreds(activeCreds);
          if (refreshed) {
            activeCreds = refreshed;
            result = await fetchClaudeUsage(activeCreds.accessToken);
          }
        }
        if (isAuthFailureStatus(result.status)) {
          continue;
        }
        if (!result.ok) {
          lastErrorSnapshot = errorSnapshot(
            'claude',
            ctx.nowMs,
            SOURCE,
            `Claude usage request failed (${result.status}).`,
          );
          continue;
        }
        const planName = claudePlanName(activeCreds);
        return parseClaudeUsage({
          json: result.json,
          nowMs: ctx.nowMs,
          ...(planName ? { planName } : {}),
        });
      } catch {
        lastErrorSnapshot = errorSnapshot(
          'claude',
          ctx.nowMs,
          SOURCE,
          'Could not reach the Claude usage endpoint.',
        );
        continue;
      }
    }

    return (
      inferenceOnlySnapshot ??
      lastErrorSnapshot ??
      needsAuthSnapshot('claude', ctx.nowMs, SOURCE)
    );
  },
};
