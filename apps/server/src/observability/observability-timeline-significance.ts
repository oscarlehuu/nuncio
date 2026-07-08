import type { TimelineEntryDto, TimelineKind } from './observability.types';

const SIGNIFICANCE: Record<TimelineKind, number> = {
  'session-needs-you': 50,
  'breaker-tripped': 40,
  'task-failed': 30,
  'loop-run-settled': 20,
  'attention-raised': 20,
  'task-done': 10,
  'session-completed': 10,
  'breaker-resumed': 10,
  'attention-resolved': 10,
  'pr-opened-detected': 10,
  'session-started': 0,
  'digest-sent': 0,
};

export function timelineSignificance(kind: TimelineKind): number {
  return SIGNIFICANCE[kind] ?? 0;
}

export function compareTimelineEntries(a: TimelineEntryDto, b: TimelineEntryDto): number {
  return b.ts - a.ts || timelineSignificance(b.kind) - timelineSignificance(a.kind) || a.id.localeCompare(b.id);
}
