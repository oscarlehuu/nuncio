import type { ObservabilityMetrics, ObservabilityQuery, ObservabilitySources } from './observability.types';
import type { SessionDto, SessionEvent, SessionStatus } from '../sessions/domain/sessions.types';
import { inWindow, payloadRecord, verifyOk } from './observability-utils';

type MetricPatch = {
  sessions?: number;
  tasks?: number;
  turns?: number;
  steers?: { total?: number; human?: number; auto?: number; queued?: number };
  verify?: { total?: number; passed?: number; failed?: number };
  loops?: number;
  attention?: { total?: number; open?: number; unacked?: number; resolved?: number };
  duration?: { totalMs?: number; runningMs?: number };
};

const TERMINAL_RUN_STATUSES = new Set<SessionStatus>(['IDLE', 'ERROR', 'PAUSED', 'ARCHIVED']);

export function emptyObservabilityMetrics(): ObservabilityMetrics {
  return {
    sessions: { total: 0 },
    tasks: { total: 0 },
    turns: { total: 0 },
    steers: { total: 0, human: 0, auto: 0, queued: 0 },
    verify: { total: 0, passed: 0, failed: 0, rate: null },
    loops: { total: 0 },
    attention: { total: 0, open: 0, unacked: 0, resolved: 0 },
    duration: { totalMs: 0, runningMs: 0 },
    usage: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      source: 'unavailable',
    },
  };
}

export function foldSources(
  sources: ObservabilitySources,
  query: ObservabilityQuery,
): ObservabilityMetrics {
  const metrics = emptyObservabilityMetrics();
  apply(metrics, {
    sessions: sources.sessions.filter((session) => inWindow(session.createdAt, query)).length,
    tasks: sources.tasks.filter((task) => inWindow(task.createdAt, query)).length,
    loops: sources.loopRuns.filter((run) => inWindow(run.createdAt, query)).length,
  });

  for (const session of sources.sessions) {
    const events = sources.eventsBySession[session.id] ?? [];
    apply(metrics, foldEventMetrics(events, query));
    apply(metrics, { duration: durationFromEvents(events, query.now) });
  }

  apply(metrics, attentionMetrics(sources, query));
  return withRates(metrics);
}

export function foldSessionMetrics(
  session: SessionDto,
  events: SessionEvent[],
  query: ObservabilityQuery,
): ObservabilityMetrics {
  const metrics = emptyObservabilityMetrics();
  apply(metrics, {
    sessions: inWindow(session.createdAt, query) ? 1 : 0,
    duration: durationFromEvents(events, query.now),
  });
  apply(metrics, foldEventMetrics(events, query));
  return withRates(metrics);
}

function attentionMetrics(sources: ObservabilitySources, query: ObservabilityQuery): MetricPatch {
  return {
    attention: {
      total: sources.attentionItems.filter((item) => inWindow(item.createdAt, query)).length,
      resolved: sources.attentionItems.filter((item) => item.resolvedAt !== null && inWindow(item.resolvedAt, query)).length,
      open: sources.attentionItems.filter((item) => item.status === 'open').length,
      unacked: sources.attentionItems.filter((item) => item.status === 'open' && item.acknowledgedAt === null).length,
    },
  };
}

function foldEventMetrics(events: SessionEvent[], query: ObservabilityQuery): MetricPatch {
  const patch: MetricPatch = {
    turns: 0,
    steers: { total: 0, human: 0, auto: 0, queued: 0 },
    verify: { total: 0, passed: 0, failed: 0 },
  };
  for (const event of events) {
    if (!inWindow(event.createdAt, query)) continue;
    if (event.type === 'user_message' || event.type === 'steer_message') {
      patch.turns = (patch.turns ?? 0) + 1;
    }
    if (event.type === 'steer_message' || event.type === 'steer_queued') {
      patch.steers!.total = (patch.steers!.total ?? 0) + 1;
      if (event.type === 'steer_queued') patch.steers!.queued = (patch.steers!.queued ?? 0) + 1;
      if (isAutoSteer(event)) patch.steers!.auto = (patch.steers!.auto ?? 0) + 1;
      else patch.steers!.human = (patch.steers!.human ?? 0) + 1;
    }
    if (event.type === 'verify_result') {
      patch.verify!.total = (patch.verify!.total ?? 0) + 1;
      if (verifyOk(event)) patch.verify!.passed = (patch.verify!.passed ?? 0) + 1;
      else patch.verify!.failed = (patch.verify!.failed ?? 0) + 1;
    }
  }
  return patch;
}

function durationFromEvents(events: SessionEvent[], now: number): { totalMs: number; runningMs: number } {
  let runningStartedAt: number | null = null;
  let totalMs = 0;
  let runningMs = 0;
  for (const event of [...events].sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq)) {
    if (event.type !== 'status') continue;
    const status = statusFromEvent(event);
    if (status === 'RUNNING' && runningStartedAt === null) {
      runningStartedAt = event.createdAt;
    } else if (status && TERMINAL_RUN_STATUSES.has(status) && runningStartedAt !== null) {
      totalMs += Math.max(0, event.createdAt - runningStartedAt);
      runningStartedAt = null;
    }
  }
  if (runningStartedAt !== null) {
    runningMs = Math.max(0, now - runningStartedAt);
    totalMs += runningMs;
  }
  return { totalMs, runningMs };
}

function apply(metrics: ObservabilityMetrics, patch: MetricPatch): void {
  metrics.sessions.total += patch.sessions ?? 0;
  metrics.tasks.total += patch.tasks ?? 0;
  metrics.turns.total += patch.turns ?? 0;
  metrics.loops.total += patch.loops ?? 0;
  metrics.steers.total += patch.steers?.total ?? 0;
  metrics.steers.human += patch.steers?.human ?? 0;
  metrics.steers.auto += patch.steers?.auto ?? 0;
  metrics.steers.queued += patch.steers?.queued ?? 0;
  metrics.verify.total += patch.verify?.total ?? 0;
  metrics.verify.passed = (metrics.verify.passed ?? 0) + (patch.verify?.passed ?? 0);
  metrics.verify.failed = (metrics.verify.failed ?? 0) + (patch.verify?.failed ?? 0);
  metrics.attention.total += patch.attention?.total ?? 0;
  metrics.attention.open += patch.attention?.open ?? 0;
  metrics.attention.unacked += patch.attention?.unacked ?? 0;
  metrics.attention.resolved += patch.attention?.resolved ?? 0;
  metrics.duration.totalMs += patch.duration?.totalMs ?? 0;
  metrics.duration.runningMs += patch.duration?.runningMs ?? 0;
}

function withRates(metrics: ObservabilityMetrics): ObservabilityMetrics {
  metrics.verify.rate = metrics.verify.total > 0 ? (metrics.verify.passed ?? 0) / metrics.verify.total : null;
  return metrics;
}

function statusFromEvent(event: SessionEvent): SessionStatus | null {
  const status = payloadRecord(event).status;
  return typeof status === 'string' ? (status as SessionStatus) : null;
}

function isAutoSteer(event: SessionEvent): boolean {
  return payloadRecord(event).origin === 'verify_retry';
}
