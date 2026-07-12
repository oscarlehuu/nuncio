import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  aggregateDailyTokens,
  buildLocalSpendLines,
  clearLocalSpendCache,
  estimateUsdFromTokens,
  formatLocalDate,
  formatTokenValue,
  loadLocalSpendLines,
  loadUsageHistory,
  localMidnightMs,
} from '../../../src/usage/usage-local-spend';
import type { ProviderUsageContext } from '../../../src/usage/usage.types';

describe('usage-local-spend helpers', () => {
  it('formats compact token values', () => {
    expect(formatTokenValue(500)).toContain('500');
    expect(formatTokenValue(12_500)).toMatch(/12\.5K|12,5K|13K/i);
  });

  it('builds Today / Last 30 Days lines only when tokens > 0', () => {
    expect(buildLocalSpendLines({ tokensToday: 0, tokens30d: 0 })).toEqual([]);
    const lines = buildLocalSpendLines({ tokensToday: 1_000, tokens30d: 50_000 });
    expect(lines.map((l) => l.label)).toEqual(['Today', 'Last 30 Days']);
    expect(lines[0]?.subtitle).toBe('Estimated from local logs');
  });

  it('computes local midnight', () => {
    const now = Date.parse('2026-07-11T15:30:00');
    const midnight = localMidnightMs(now);
    const d = new Date(midnight);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it('aggregates samples into daily buckets', () => {
    const now = Date.parse('2026-07-11T15:00:00');
    const today = localMidnightMs(now) + 3_600_000;
    const yesterday = today - 24 * 60 * 60 * 1000;
    const days = aggregateDailyTokens(
      [
        { timestampMs: today, totalTokens: 100 },
        { timestampMs: today, totalTokens: 50 },
        { timestampMs: yesterday, totalTokens: 200 },
      ],
      now,
      3,
    );
    expect(days).toHaveLength(3);
    expect(days[2]?.date).toBe(formatLocalDate(now));
    expect(days[2]?.tokens).toBe(150);
    expect(days[1]?.tokens).toBe(200);
    expect(days[0]?.tokens).toBe(0);
  });

  it('estimates USD from blended $/MTok rates', () => {
    expect(estimateUsdFromTokens('claude', 1_000_000)).toBeCloseTo(5, 5);
    expect(estimateUsdFromTokens('codex', 2_000_000)).toBeCloseTo(10, 5);
    expect(estimateUsdFromTokens('cursor', 500_000)).toBeCloseTo(5, 5);
    expect(estimateUsdFromTokens('claude', 0)).toBe(0);
  });
});

describe('loadLocalSpendLines from fixtures', () => {
  let root: string;

  beforeEach(() => {
    clearLocalSpendCache();
    root = mkdtempSync(join(tmpdir(), 'nuncio-local-spend-'));
  });

  afterEach(() => {
    clearLocalSpendCache();
    rmSync(root, { recursive: true, force: true });
  });

  it('aggregates Claude assistant usage into Today and Last 30 Days', async () => {
    const projectDir = join(root, '.claude', 'projects', 'demo');
    mkdirSync(projectDir, { recursive: true });
    const now = Date.now();
    const todayIso = new Date(now - 60_000).toISOString();
    const oldIso = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(projectDir, 'session.jsonl'),
      [
        JSON.stringify({
          type: 'assistant',
          timestamp: todayIso,
          requestId: 'r1',
          sessionId: 's1',
          message: {
            id: 'm1',
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: oldIso,
          requestId: 'r2',
          sessionId: 's1',
          message: {
            id: 'm2',
            usage: { input_tokens: 1000, output_tokens: 500 },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const ctx: ProviderUsageContext = {
      homeDir: root,
      env: {},
      platform: process.platform,
      nowMs: now,
    };
    const lines = await loadLocalSpendLines('claude', ctx);
    expect(lines.some((l) => l.label === 'Today')).toBe(true);
    expect(lines.some((l) => l.label === 'Last 30 Days')).toBe(true);
    const today = lines.find((l) => l.label === 'Today');
    expect(today?.value).toContain('150');
  });

  it('aggregates Codex session token_count totals', async () => {
    const now = new Date();
    const dayDir = join(
      root,
      '.codex',
      'sessions',
      `${now.getFullYear()}`,
      `${String(now.getMonth() + 1).padStart(2, '0')}`,
      `${String(now.getDate()).padStart(2, '0')}`,
    );
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(
      join(dayDir, 'rollout.jsonl'),
      JSON.stringify({
        timestamp: new Date(now.getTime() - 30_000).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { total_tokens: 42_000 } },
        },
      }) + '\n',
      'utf8',
    );

    const ctx: ProviderUsageContext = {
      homeDir: root,
      env: {},
      platform: process.platform,
      nowMs: now.getTime(),
    };
    const lines = await loadLocalSpendLines('codex', ctx);
    expect(lines.find((l) => l.label === 'Today')?.value).toMatch(/42/);
  });

  it('aggregates Cursor transcript usage when token fields exist', async () => {
    const transcriptDir = join(
      root,
      '.cursor',
      'projects',
      'demo',
      'agent-transcripts',
      'chat-1',
    );
    mkdirSync(transcriptDir, { recursive: true });
    const now = Date.now();
    writeFileSync(
      join(transcriptDir, 'session.jsonl'),
      JSON.stringify({
        role: 'assistant',
        timestamp: new Date(now - 10_000).toISOString(),
        usage: { input_tokens: 200, output_tokens: 100 },
      }) + '\n',
      'utf8',
    );

    const lines = await loadLocalSpendLines('cursor', {
      homeDir: root,
      env: {},
      platform: process.platform,
      nowMs: now,
    });
    expect(lines.find((l) => l.label === 'Today')?.value).toMatch(/300/);
  });

  it('returns empty Cursor lines when transcripts lack token fields', async () => {
    const transcriptDir = join(
      root,
      '.cursor',
      'projects',
      'demo',
      'agent-transcripts',
      'chat-1',
    );
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      join(transcriptDir, 'session.jsonl'),
      JSON.stringify({ role: 'user', input: { text: 'hi' }, timestamp: new Date().toISOString() }) +
        '\n',
      'utf8',
    );
    const lines = await loadLocalSpendLines('cursor', {
      homeDir: root,
      env: {},
      platform: process.platform,
      nowMs: Date.now(),
    });
    expect(lines).toEqual([]);
  });

  it('skips re-parse when mtime fingerprint is unchanged within TTL', async () => {
    const projectDir = join(root, '.claude', 'projects', 'demo');
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, 'session.jsonl');
    const now = Date.now();
    writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(now - 1_000).toISOString(),
        requestId: 'r1',
        message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 5 } },
      }) + '\n',
      'utf8',
    );
    // Freeze mtime so fingerprint stays stable across reads.
    const frozen = new Date(now - 60_000);
    utimesSync(file, frozen, frozen);

    const ctx: ProviderUsageContext = {
      homeDir: root,
      env: {},
      platform: process.platform,
      nowMs: now,
    };
    const first = await loadLocalSpendLines('claude', ctx);
    expect(first.find((l) => l.label === 'Today')?.value).toContain('15');

    // Overwrite with different tokens but keep same mtime — cache should return first result.
    writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(now - 1_000).toISOString(),
        requestId: 'r2',
        message: { id: 'm2', usage: { input_tokens: 999, output_tokens: 1 } },
      }) + '\n',
      'utf8',
    );
    utimesSync(file, frozen, frozen);

    const second = await loadLocalSpendLines('claude', { ...ctx, nowMs: now + 1_000 });
    expect(second).toEqual(first);
  });

  it('builds usage history days across providers', async () => {
    const now = Date.now();
    const todayIso = new Date(now - 30_000).toISOString();

    const claudeDir = join(root, '.claude', 'projects', 'demo');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'session.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: todayIso,
        requestId: 'r1',
        message: { id: 'm1', usage: { input_tokens: 100, output_tokens: 0 } },
      }) + '\n',
      'utf8',
    );

    const d = new Date(now);
    const codexDir = join(
      root,
      '.codex',
      'sessions',
      `${d.getFullYear()}`,
      `${String(d.getMonth() + 1).padStart(2, '0')}`,
      `${String(d.getDate()).padStart(2, '0')}`,
    );
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, 'rollout.jsonl'),
      JSON.stringify({
        timestamp: todayIso,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { total_tokens: 200 } },
        },
      }) + '\n',
      'utf8',
    );

    const history = await loadUsageHistory(
      {
        homeDir: root,
        env: {},
        platform: process.platform,
        nowMs: now,
      },
      7,
    );

    expect(history.days).toHaveLength(7);
    const last = history.days[history.days.length - 1]!;
    expect(last.claude).toBe(100);
    expect(last.codex).toBe(200);
    expect(last.cursor).toBe(0);
    expect(history.totals.claude).toBe(100);
    expect(history.totals.codex).toBe(200);
    expect(history.estimatedUsdTotals.claude).toBeCloseTo(0.0005, 6);
    expect(typeof history.updatedAt).toBe('string');
  });
});
