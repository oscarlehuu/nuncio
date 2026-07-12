/**
 * Local token spend from on-disk Claude / Codex / Cursor session archives.
 * Values are measured token totals (not subscription charges). Labels match
 * OpenUsage: Today (local midnight) + Last 30 Days. History buckets feed the
 * Settings analytics chart.
 */

import type { Dirent, Stats } from 'node:fs';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import type {
  ProviderUsageContext,
  UsageHistoryDto,
  UsageHistoryDayDto,
  UsageLineDto,
  UsageProviderId,
} from './usage.types';

const ROLLUP_30D_DAYS = 30;
/** Max calendar days returned by `/api/usage/history` (heatmap). */
export const HISTORY_MAX_DAYS = 90;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_30D_MS = ROLLUP_30D_DAYS * ONE_DAY_MS;
const MAX_RECENT_USAGE_FILES = 2_000;
const READ_CONCURRENCY = 16;
const LOCAL_SPEND_CACHE_TTL_MS = 5 * 60_000;
const ESTIMATE_SUBTITLE = 'Estimated from local logs';

/** Blended USD per 1M tokens (rough; UI always labels as estimate). */
const USD_PER_MTOK: Record<UsageProviderId, number> = {
  claude: 5,
  codex: 5,
  cursor: 10,
};

export interface TokenSample {
  timestampMs: number;
  totalTokens: number;
}

interface DailyBucket {
  date: string;
  tokens: number;
}

interface SamplesCacheEntry {
  expiresAtMs: number;
  fingerprint: string;
  samples: TokenSample[];
  pending: Promise<TokenSample[]> | null;
}

const samplesCache = new Map<string, SamplesCacheEntry>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  const parsed = asFiniteNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Accept epoch seconds or ms.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function formatCompactNumber(value: number): string {
  const absoluteValue = Math.abs(value);
  if (absoluteValue < 1_000) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
  }
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: absoluteValue < 1_000_000 ? 1 : 0,
  }).format(value);
}

export function formatTokenValue(tokens: number): string {
  return `${formatCompactNumber(tokens)} tokens`;
}

/** Start of today in the host local timezone (OpenUsage calendar-day semantics). */
export function localMidnightMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatLocalDate(nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function estimateUsdFromTokens(provider: UsageProviderId, tokens: number): number {
  if (tokens <= 0) return 0;
  return (tokens / 1_000_000) * USD_PER_MTOK[provider];
}

export function buildLocalSpendLines(input: {
  tokensToday: number;
  tokens30d: number;
}): UsageLineDto[] {
  const lines: UsageLineDto[] = [];
  if (input.tokensToday > 0) {
    lines.push({
      label: 'Today',
      value: formatTokenValue(input.tokensToday),
      subtitle: ESTIMATE_SUBTITLE,
    });
  }
  if (input.tokens30d > 0) {
    lines.push({
      label: 'Last 30 Days',
      value: formatTokenValue(input.tokens30d),
      subtitle: ESTIMATE_SUBTITLE,
    });
  }
  return lines;
}

/**
 * Build `dayCount` calendar days ending today (local), oldest → newest.
 * Samples outside the window are ignored.
 */
export function aggregateDailyTokens(
  samples: ReadonlyArray<TokenSample>,
  nowMs: number,
  dayCount: number = HISTORY_MAX_DAYS,
): DailyBucket[] {
  const days = Math.max(1, Math.min(dayCount, HISTORY_MAX_DAYS));
  const todayStart = localMidnightMs(nowMs);
  const buckets = new Map<string, number>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const dayMs = todayStart - offset * ONE_DAY_MS;
    buckets.set(formatLocalDate(dayMs), 0);
  }
  const windowStart = todayStart - (days - 1) * ONE_DAY_MS;
  for (const sample of samples) {
    if (sample.timestampMs < windowStart || sample.timestampMs > nowMs + ONE_DAY_MS) continue;
    const key = formatLocalDate(sample.timestampMs);
    if (!buckets.has(key)) continue;
    buckets.set(key, (buckets.get(key) ?? 0) + sample.totalTokens);
  }
  return [...buckets.entries()].map(([date, tokens]) => ({ date, tokens }));
}

async function safeReadDir(path: string): Promise<ReadonlyArray<Dirent>> {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(path: string): Promise<Stats | null> {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: Array<{ index: number; value: R }> = [];
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(items.length, 1));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        const item = items[index];
        if (item === undefined) continue;
        results.push({ index, value: await mapper(item) });
      }
    }),
  );

  return results
    .toSorted((left, right) => left.index - right.index)
    .map((entry) => entry.value);
}

async function listRecentFiles(
  paths: ReadonlyArray<string>,
  maxFiles: number = MAX_RECENT_USAGE_FILES,
): Promise<ReadonlyArray<{ path: string; mtimeMs: number }>> {
  const filesWithStats = await mapWithConcurrency(paths, READ_CONCURRENCY, async (path) => ({
    path,
    mtimeMs: (await safeStat(path))?.mtimeMs ?? 0,
  }));

  return filesWithStats
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxFiles);
}

function fingerprintFiles(files: ReadonlyArray<{ path: string; mtimeMs: number }>): string {
  if (files.length === 0) return 'empty';
  let maxMtime = 0;
  for (const file of files) {
    if (file.mtimeMs > maxMtime) maxMtime = file.mtimeMs;
  }
  return `${files.length}:${maxMtime}`;
}

function readUsageTotalTokens(value: unknown): number {
  const usage = asRecord(value);
  if (!usage) return 0;
  const inputTokens =
    (asNonNegativeNumber(usage.input_tokens) ?? asNonNegativeNumber(usage.inputTokens) ?? 0) +
    (asNonNegativeNumber(usage.cache_creation_input_tokens) ??
      asNonNegativeNumber(usage.cacheCreationInputTokens) ??
      0) +
    (asNonNegativeNumber(usage.cache_read_input_tokens) ??
      asNonNegativeNumber(usage.cacheReadInputTokens) ??
      0);
  const outputTokens =
    asNonNegativeNumber(usage.output_tokens) ?? asNonNegativeNumber(usage.outputTokens) ?? 0;
  return (
    asNonNegativeNumber(usage.total_tokens) ??
    asNonNegativeNumber(usage.totalTokens) ??
    inputTokens + outputTokens
  );
}

function readCodexTotalTokens(payload: Record<string, unknown>): number {
  const info = asRecord(payload.info);
  const totalUsage =
    asRecord(info?.total_token_usage) ??
    asRecord(info?.totalTokenUsage) ??
    asRecord(payload.total_token_usage) ??
    asRecord(payload.totalTokenUsage);

  return (
    asNonNegativeNumber(totalUsage?.total_tokens) ??
    asNonNegativeNumber(totalUsage?.totalTokens) ??
    asNonNegativeNumber(payload.total_tokens) ??
    asNonNegativeNumber(payload.totalTokens) ??
    0
  );
}

async function listRecentCodexSessionFiles(
  sessionsRoot: string,
): Promise<ReadonlyArray<{ path: string; mtimeMs: number }>> {
  const now = new Date();
  const candidates: string[] = [];

  for (let offset = 0; offset <= HISTORY_MAX_DAYS; offset += 1) {
    const current = new Date(now);
    current.setDate(now.getDate() - offset);
    const dayDir = nodePath.join(
      sessionsRoot,
      `${current.getFullYear()}`,
      `${String(current.getMonth() + 1).padStart(2, '0')}`,
      `${String(current.getDate()).padStart(2, '0')}`,
    );
    const entries = await safeReadDir(dayDir);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        candidates.push(nodePath.join(dayDir, entry.name));
      }
    }
  }

  return listRecentFiles(candidates);
}

async function readCodexSessionTokens(path: string): Promise<TokenSample | null> {
  let fileContents: string;
  try {
    fileContents = await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }

  const lines = fileContents.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line?.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (!record || record.type !== 'event_msg') continue;
    const payload = asRecord(record.payload);
    if (!payload || payload.type !== 'token_count') continue;
    const timestampMs = parseTimestampMs(record.timestamp ?? payload.timestamp);
    if (timestampMs === null) continue;
    return { timestampMs, totalTokens: readCodexTotalTokens(payload) };
  }
  return null;
}

async function listRecentClaudeTranscriptFiles(
  projectsRoot: string,
): Promise<ReadonlyArray<{ path: string; mtimeMs: number }>> {
  const candidates: string[] = [];
  for (const projectEntry of await safeReadDir(projectsRoot)) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = nodePath.join(projectsRoot, projectEntry.name);
    for (const transcriptEntry of await safeReadDir(projectDir)) {
      if (transcriptEntry.isFile() && transcriptEntry.name.endsWith('.jsonl')) {
        candidates.push(nodePath.join(projectDir, transcriptEntry.name));
      }
    }
  }
  return listRecentFiles(candidates);
}

async function listRecentCursorTranscriptFiles(
  projectsRoot: string,
): Promise<ReadonlyArray<{ path: string; mtimeMs: number }>> {
  const candidates: string[] = [];
  for (const projectEntry of await safeReadDir(projectsRoot)) {
    if (!projectEntry.isDirectory()) continue;
    const transcriptsRoot = nodePath.join(projectsRoot, projectEntry.name, 'agent-transcripts');
    for (const chatEntry of await safeReadDir(transcriptsRoot)) {
      if (chatEntry.isDirectory()) {
        const chatDir = nodePath.join(transcriptsRoot, chatEntry.name);
        for (const fileEntry of await safeReadDir(chatDir)) {
          if (fileEntry.isFile() && fileEntry.name.endsWith('.jsonl')) {
            candidates.push(nodePath.join(chatDir, fileEntry.name));
          }
        }
      } else if (chatEntry.isFile() && chatEntry.name.endsWith('.jsonl')) {
        candidates.push(nodePath.join(transcriptsRoot, chatEntry.name));
      }
    }
  }
  return listRecentFiles(candidates);
}

async function readClaudeUsageSamples(path: string): Promise<TokenSample[]> {
  let fileContents: string;
  try {
    fileContents = await fs.readFile(path, 'utf8');
  } catch {
    return [];
  }

  const samples: TokenSample[] = [];
  const seenKeys = new Set<string>();
  const lines = fileContents.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (!record) continue;

    if (record.type === 'assistant') {
      const message = asRecord(record.message);
      const usage = asRecord(message?.usage);
      const totalTokens = readUsageTotalTokens(usage);
      const timestampMs = parseTimestampMs(record.timestamp);
      if (!usage || totalTokens <= 0 || timestampMs === null) continue;
      const dedupeKey =
        `assistant:` +
        (asString(record.requestId) ?? asString(message?.id) ?? asString(record.uuid) ?? `${path}:${index}`);
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      samples.push({ timestampMs, totalTokens });
      continue;
    }

    const toolUseResult = asRecord(record.toolUseResult);
    const toolUsage = asRecord(toolUseResult?.usage);
    const toolTokens = readUsageTotalTokens(toolUsage);
    const toolTs = parseTimestampMs(record.timestamp);
    if (!toolUseResult || !toolUsage || toolTokens <= 0 || toolTs === null) continue;
    const toolKey =
      `tool:` +
      (asString(record.uuid) ??
        asString(toolUseResult.agentId) ??
        asString(record.requestId) ??
        `${path}:${index}`);
    if (seenKeys.has(toolKey)) continue;
    seenKeys.add(toolKey);
    samples.push({ timestampMs: toolTs, totalTokens: toolTokens });
  }

  return samples;
}

/** Best-effort: any JSONL record with a usage / *tokens* object. */
async function readCursorUsageSamples(path: string): Promise<TokenSample[]> {
  let fileContents: string;
  try {
    fileContents = await fs.readFile(path, 'utf8');
  } catch {
    return [];
  }

  const samples: TokenSample[] = [];
  const lines = fileContents.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (!record) continue;

    const usage =
      asRecord(record.usage) ??
      asRecord(asRecord(record.message)?.usage) ??
      asRecord(asRecord(record.tokenUsage)?.usage) ??
      asRecord(record.tokenUsage);

    const totalTokens = readUsageTotalTokens(usage);
    if (totalTokens <= 0) continue;
    const timestampMs =
      parseTimestampMs(record.timestamp) ??
      parseTimestampMs(record.createdAt) ??
      parseTimestampMs(record.created_at);
    if (timestampMs === null) continue;
    samples.push({ timestampMs, totalTokens });
  }

  return samples;
}

function aggregateLines(samples: ReadonlyArray<TokenSample>, nowMs: number): UsageLineDto[] {
  const todayStart = localMidnightMs(nowMs);
  const cutoff30d = nowMs - LOOKBACK_30D_MS;
  let tokensToday = 0;
  let tokens30d = 0;
  for (const sample of samples) {
    if (sample.timestampMs >= cutoff30d) tokens30d += sample.totalTokens;
    if (sample.timestampMs >= todayStart) tokensToday += sample.totalTokens;
  }
  return buildLocalSpendLines({ tokensToday, tokens30d });
}

async function collectProviderSamples(
  provider: UsageProviderId,
  ctx: ProviderUsageContext,
): Promise<{ fingerprint: string; samples: TokenSample[] }> {
  if (provider === 'claude') {
    const configDir = asString(ctx.env.CLAUDE_CONFIG_DIR) ?? nodePath.join(ctx.homeDir, '.claude');
    const files = await listRecentClaudeTranscriptFiles(nodePath.join(configDir, 'projects'));
    const fingerprint = fingerprintFiles(files);
    if (files.length === 0) return { fingerprint, samples: [] };
    const samples = (
      await mapWithConcurrency(
        files.map((f) => f.path),
        READ_CONCURRENCY,
        readClaudeUsageSamples,
      )
    ).flat();
    return { fingerprint, samples };
  }

  if (provider === 'codex') {
    const codexHome = asString(ctx.env.CODEX_HOME) ?? nodePath.join(ctx.homeDir, '.codex');
    const files = await listRecentCodexSessionFiles(nodePath.join(codexHome, 'sessions'));
    const fingerprint = fingerprintFiles(files);
    if (files.length === 0) return { fingerprint, samples: [] };
    const summaries = (
      await mapWithConcurrency(
        files.map((f) => f.path),
        READ_CONCURRENCY,
        readCodexSessionTokens,
      )
    ).filter((sample): sample is TokenSample => sample !== null);
    return { fingerprint, samples: summaries };
  }

  // cursor
  const cursorRoot = nodePath.join(ctx.homeDir, '.cursor', 'projects');
  const files = await listRecentCursorTranscriptFiles(cursorRoot);
  const fingerprint = fingerprintFiles(files);
  if (files.length === 0) return { fingerprint, samples: [] };
  const samples = (
    await mapWithConcurrency(
      files.map((f) => f.path),
      READ_CONCURRENCY,
      readCursorUsageSamples,
    )
  ).flat();
  return { fingerprint, samples };
}

function cacheKeyFor(provider: UsageProviderId, ctx: ProviderUsageContext): string {
  return `${provider}:${ctx.homeDir}:${asString(ctx.env.CLAUDE_CONFIG_DIR) ?? ''}:${asString(ctx.env.CODEX_HOME) ?? ''}`;
}

async function loadProviderSamples(
  provider: UsageProviderId,
  ctx: ProviderUsageContext,
  options: { forceRefresh?: boolean } = {},
): Promise<TokenSample[]> {
  const cacheKey = cacheKeyFor(provider, ctx);
  const existing = samplesCache.get(cacheKey);

  // Fast path: TTL hit — return cached samples without even listing files.
  if (
    !options.forceRefresh &&
    existing &&
    existing.expiresAtMs > ctx.nowMs &&
    !existing.pending
  ) {
    return existing.samples;
  }
  if (!options.forceRefresh && existing?.pending) {
    return existing.pending;
  }

  const pending = (async () => {
    try {
      const { fingerprint, samples } = await collectProviderSamples(provider, ctx);
      // Mtime fingerprint: if files unchanged and we have a prior entry, reuse samples.
      if (
        !options.forceRefresh &&
        existing &&
        existing.fingerprint === fingerprint &&
        existing.fingerprint !== 'empty'
      ) {
        samplesCache.set(cacheKey, {
          expiresAtMs: Date.now() + LOCAL_SPEND_CACHE_TTL_MS,
          fingerprint,
          samples: existing.samples,
          pending: null,
        });
        return existing.samples;
      }
      samplesCache.set(cacheKey, {
        expiresAtMs: Date.now() + LOCAL_SPEND_CACHE_TTL_MS,
        fingerprint,
        samples,
        pending: null,
      });
      return samples;
    } catch {
      samplesCache.set(cacheKey, {
        expiresAtMs: 0,
        fingerprint: 'error',
        samples: [],
        pending: null,
      });
      return [];
    }
  })();

  samplesCache.set(cacheKey, {
    expiresAtMs: existing?.expiresAtMs ?? 0,
    fingerprint: existing?.fingerprint ?? '',
    samples: existing?.samples ?? [],
    pending,
  });

  return pending;
}

/** Clear cache (tests). */
export function clearLocalSpendCache(): void {
  samplesCache.clear();
}

/**
 * Append Today / Last 30 Days token lines for Claude, Codex, and Cursor (when
 * token fields exist). Never throws.
 */
export async function loadLocalSpendLines(
  provider: UsageProviderId,
  ctx: ProviderUsageContext,
  options: { forceRefresh?: boolean } = {},
): Promise<UsageLineDto[]> {
  try {
    const samples = await loadProviderSamples(provider, ctx, options);
    return aggregateLines(samples, ctx.nowMs);
  } catch {
    return [];
  }
}

function emptyProviderTotals(): Record<UsageProviderId, number> {
  return { claude: 0, codex: 0, cursor: 0 };
}

/**
 * Last N local calendar days of token totals per provider (oldest → newest).
 * Never throws.
 */
export async function loadUsageHistory(
  ctx: ProviderUsageContext,
  days: number = HISTORY_MAX_DAYS,
  options: { forceRefresh?: boolean } = {},
): Promise<UsageHistoryDto> {
  const dayCount = Math.max(1, Math.min(days, HISTORY_MAX_DAYS));
  const perProvider = emptyProviderTotals();
  const dailyMaps: Record<UsageProviderId, Map<string, number>> = {
    claude: new Map(),
    codex: new Map(),
    cursor: new Map(),
  };

  await Promise.all(
    (['claude', 'codex', 'cursor'] as const).map(async (provider) => {
      const samples = await loadProviderSamples(provider, ctx, options);
      const buckets = aggregateDailyTokens(samples, ctx.nowMs, dayCount);
      for (const bucket of buckets) {
        dailyMaps[provider].set(bucket.date, bucket.tokens);
        perProvider[provider] += bucket.tokens;
      }
    }),
  );

  const todayStart = localMidnightMs(ctx.nowMs);
  const historyDays: UsageHistoryDayDto[] = [];
  for (let offset = dayCount - 1; offset >= 0; offset -= 1) {
    const dayMs = todayStart - offset * ONE_DAY_MS;
    const date = formatLocalDate(dayMs);
    historyDays.push({
      date,
      claude: dailyMaps.claude.get(date) ?? 0,
      codex: dailyMaps.codex.get(date) ?? 0,
      cursor: dailyMaps.cursor.get(date) ?? 0,
    });
  }

  return {
    days: historyDays,
    totals: { ...perProvider },
    estimatedUsdTotals: {
      claude: estimateUsdFromTokens('claude', perProvider.claude),
      codex: estimateUsdFromTokens('codex', perProvider.codex),
      cursor: estimateUsdFromTokens('cursor', perProvider.cursor),
    },
    updatedAt: new Date(ctx.nowMs).toISOString(),
  };
}
