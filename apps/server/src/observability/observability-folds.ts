import type {
  ObservabilityMetrics,
  ObservabilityQuery,
  ObservabilitySources,
  SessionObservabilityDto,
} from './observability.types';
import { emptyObservabilityMetrics, foldSessionMetrics, foldSources } from './observability-metrics';
export { emptyObservabilityMetrics } from './observability-metrics';
export { foldObservabilityRollups } from './observability-rollups';
export { buildGlobalTimeline } from './observability-timeline';

export function foldObservabilitySummary(
  sources: ObservabilitySources,
  query: ObservabilityQuery,
): ObservabilityMetrics {
  return foldSources(sources, query);
}

export function foldSessionObservability(
  sources: ObservabilitySources,
  sessionId: string,
  query: ObservabilityQuery,
): SessionObservabilityDto {
  const session = sources.sessions.find((s) => s.id === sessionId);
  if (!session) {
    return {
      sessionId,
      provider: 'unknown',
      projectPath: null,
      metrics: emptyObservabilityMetrics(),
    };
  }
  return {
    sessionId: session.id,
    provider: session.provider,
    projectPath: session.projectPath ?? null,
    metrics: foldSessionMetrics(session, sources.eventsBySession[session.id] ?? [], query),
  };
}
