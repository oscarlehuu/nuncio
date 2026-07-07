import type { ParsedSpec } from './scheduler.types';

/**
 * v1 cron subset parser + next-fire computer. SKELETON — the red suite drives the
 * contract; functions throw until implemented so tests fail for missing-feature
 * rather than an unresolved import. Supported specs (timezone-naive, local frame):
 *   daily@HH:MM · every:<N>m|<N>h · <weekday>@HH:MM (mon..sun)
 */
export function parseScheduleSpec(_spec: string): ParsedSpec {
  throw new Error('TODO: schedule parser unimplemented');
}

/** Next fire strictly after `now` (epoch ms) for a parsed spec. */
export function nextFireAfter(_spec: ParsedSpec, _now: number): number {
  throw new Error('TODO: next-fire computer unimplemented');
}
