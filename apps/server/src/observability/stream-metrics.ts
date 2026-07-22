/**
 * Pure analyzer for a session's streaming event log.
 *
 * Turns a flat list of streaming events (turn boundaries, token deltas, tool
 * activity) into per-turn latency, throughput, and stall metrics. The input is
 * treated as untrusted: rows are sanitized and stable-sorted by timestamp
 * before any metric is derived, so out-of-order or malformed logs are safe.
 */

export type StreamEventType = 'turn_start' | 'delta' | 'tool_call' | 'tool_result' | 'turn_end';

export interface StreamEventInput {
  ts: number; // epoch milliseconds
  type: StreamEventType;
  tokens?: number; // only meaningful on 'delta'
}

export interface StreamStall {
  turnIndex: number; // 0-based index of the turn the stall occurred in
  startTs: number; // ts of the delta BEFORE the gap
  gapMs: number;
}

export interface StreamMetricsReport {
  turns: number;
  ttftMs: { perTurn: (number | null)[]; median: number | null };
  interDeltaGapMs: { p50: number | null; p95: number | null; max: number | null };
  tokensPerSecond: number | null;
  stalls: StreamStall[];
  totalDeltaTokens: number;
}

const EVENT_TYPES: Record<StreamEventType, true> = {
  turn_start: true,
  delta: true,
  tool_call: true,
  tool_result: true,
  turn_end: true,
};

interface CountedDelta {
  ts: number;
  tokens: number;
  turnIndex: number;
}

interface OpenTurn {
  index: number;
  startTs: number;
  deltas: CountedDelta[];
  closed: boolean;
}

function sanitize(events: unknown[]): StreamEventInput[] {
  const clean: StreamEventInput[] = [];
  for (const row of events) {
    if (typeof row !== 'object' || row === null) continue;
    const { ts, type, tokens } = row as { ts?: unknown; type?: unknown; tokens?: unknown };
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    if (typeof type !== 'string' || EVENT_TYPES[type as StreamEventType] !== true) continue;
    const event: StreamEventInput = { ts, type: type as StreamEventType };
    if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0) {
      event.tokens = tokens;
    }
    clean.push(event);
  }
  // Stable sort by ts ascending (Array.prototype.sort is stable in modern engines).
  return clean
    .map((event, order) => ({ event, order }))
    .sort((a, b) => a.event.ts - b.event.ts || a.order - b.order)
    .map(({ event }) => event);
}

function nearestRank(sorted: number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  const position = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[position - 1];
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function computeStreamMetrics(
  events: unknown[],
  opts?: { stallThresholdMs?: number },
): StreamMetricsReport {
  const stallThresholdMs = opts?.stallThresholdMs ?? 2000;
  const ordered = sanitize(events);

  const turns: OpenTurn[] = [];
  let current: OpenTurn | null = null;

  for (const event of ordered) {
    switch (event.type) {
      case 'turn_start': {
        current = { index: turns.length, startTs: event.ts, deltas: [], closed: false };
        turns.push(current);
        break;
      }
      case 'turn_end': {
        if (current) current.closed = true;
        current = null;
        break;
      }
      case 'delta': {
        if (!current) break; // ignore deltas outside an open turn
        const tokens = event.tokens === undefined ? 1 : event.tokens;
        current.deltas.push({ ts: event.ts, tokens, turnIndex: current.index });
        break;
      }
      case 'tool_call':
      case 'tool_result':
        break; // never affect metrics
      default: {
        const exhaustive: never = event.type;
        void exhaustive;
      }
    }
  }

  const perTurn: (number | null)[] = turns.map((turn) =>
    turn.deltas.length > 0 ? turn.deltas[0].ts - turn.startTs : null,
  );
  const ttftValues = perTurn.filter((value): value is number => value !== null).sort((a, b) => a - b);
  const ttftMedian = median(ttftValues);

  const gaps: number[] = [];
  const stalls: StreamStall[] = [];
  for (const turn of turns) {
    for (let i = 1; i < turn.deltas.length; i += 1) {
      const gapMs = turn.deltas[i].ts - turn.deltas[i - 1].ts;
      gaps.push(gapMs);
      if (gapMs > stallThresholdMs) {
        stalls.push({ turnIndex: turn.index, startTs: turn.deltas[i - 1].ts, gapMs });
      }
    }
  }
  const sortedGaps = [...gaps].sort((a, b) => a - b);

  let totalDeltaTokens = 0;
  for (const turn of turns) {
    for (const delta of turn.deltas) {
      totalDeltaTokens += delta.tokens;
    }
  }

  let tokensPerSecond: number | null = null;
  let streamedTokens = 0;
  let streamingDurationMs = 0;
  for (const turn of turns) {
    if (turn.deltas.length < 2) continue;
    const durationMs = turn.deltas.at(-1)!.ts - turn.deltas[0]!.ts;
    if (durationMs <= 0) continue;
    streamingDurationMs += durationMs;
    streamedTokens += turn.deltas.reduce((sum, delta) => sum + delta.tokens, 0);
  }
  if (streamingDurationMs > 0) {
    tokensPerSecond = streamedTokens / (streamingDurationMs / 1000);
  }

  return {
    turns: turns.length,
    ttftMs: { perTurn, median: ttftMedian },
    interDeltaGapMs: {
      p50: nearestRank(sortedGaps, 50),
      p95: nearestRank(sortedGaps, 95),
      max: sortedGaps.length > 0 ? sortedGaps[sortedGaps.length - 1] : null,
    },
    tokensPerSecond,
    stalls,
    totalDeltaTokens,
  };
}
