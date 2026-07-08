import type {
  ObservabilityMetrics,
  ObservabilityQuery,
  ObservabilityRollupDto,
  ObservabilitySources,
  SessionObservabilityDto,
  TimelineEntryDto,
  TimelineQuery,
} from './observability.types';

export function emptyObservabilityMetrics(): ObservabilityMetrics {
  throw new Error('TODO: implement observability empty metrics');
}

export function foldObservabilitySummary(
  _sources: ObservabilitySources,
  _query: ObservabilityQuery,
): ObservabilityMetrics {
  throw new Error('TODO: implement observability summary fold');
}

export function foldSessionObservability(
  _sources: ObservabilitySources,
  _sessionId: string,
  _query: ObservabilityQuery,
): SessionObservabilityDto {
  throw new Error('TODO: implement session observability fold');
}

export function foldObservabilityRollups(
  _sources: ObservabilitySources,
  _query: ObservabilityQuery,
): ObservabilityRollupDto[] {
  throw new Error('TODO: implement observability rollup fold');
}

export function buildGlobalTimeline(
  _sources: ObservabilitySources,
  _query: TimelineQuery,
): TimelineEntryDto[] {
  throw new Error('TODO: implement observability global timeline fold');
}
