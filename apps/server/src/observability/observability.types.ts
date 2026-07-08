import type { AttentionItemDto } from '../attention/attention.types';
import type { DigestRunDto } from '../attention/heartbeat/heartbeat.types';
import type { LoopRunDto } from '../loops/loops.types';
import type { SessionDto, SessionEvent } from '../sessions/domain/sessions.types';
import type { TaskDto } from '../tasks/tasks.types';

export interface ObservabilityWindow {
  from: number;
  to: number;
}

export interface ObservabilityClock {
  now(): number;
}

export interface UsageMetric {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  source: 'provider-reported' | 'unavailable';
}

export interface CountMetric {
  total: number;
  passed?: number;
  failed?: number;
  rate?: number | null;
}

export interface DurationMetric {
  totalMs: number;
  runningMs: number;
}

export interface ObservabilityMetrics {
  sessions: CountMetric;
  tasks: CountMetric;
  turns: CountMetric;
  steers: CountMetric & { human: number; auto: number; queued: number };
  verify: CountMetric & { rate: number | null };
  loops: CountMetric;
  attention: CountMetric & { open: number; unacked: number; resolved: number };
  duration: DurationMetric;
  usage: UsageMetric;
}

export interface SessionObservabilityDto {
  sessionId: string;
  provider: string;
  projectPath: string | null;
  metrics: ObservabilityMetrics;
}

export type RollupDimension = 'provider' | 'project' | 'day';

export interface ObservabilityRollupDto {
  dimension: RollupDimension;
  key: string;
  label: string;
  metrics: ObservabilityMetrics;
}

export type TimelineKind =
  | 'session'
  | 'task'
  | 'loop-run'
  | 'attention'
  | 'digest'
  | 'verify'
  | 'steer';

export interface TimelineEntryDto {
  id: string;
  at: number;
  kind: TimelineKind;
  title: string;
  projectPath: string | null;
  provider: string | null;
  sessionId?: string;
  taskId?: string;
  loopId?: string;
  severity?: number;
}

export interface ObservabilitySources {
  sessions: SessionDto[];
  eventsBySession: Record<string, SessionEvent[]>;
  tasks: TaskDto[];
  loopRuns: LoopRunDto[];
  attentionItems: AttentionItemDto[];
  digestRuns: DigestRunDto[];
}

export interface ObservabilityQuery {
  window: ObservabilityWindow;
  now: number;
}

export interface TimelineQuery extends ObservabilityQuery {
  provider?: string;
  projectPath?: string;
}
