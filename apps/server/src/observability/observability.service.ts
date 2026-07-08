import { Injectable } from '@nestjs/common';
import { AttentionRepository } from '../attention/attention.repository';
import { DigestRepository } from '../attention/heartbeat/digest.repository';
import { LoopsRepository } from '../loops/loops.repository';
import type { Clock } from '../scheduler/scheduler.types';
import { EventsRepository } from '../sessions/persistence/events.repository';
import { SessionsRepository } from '../sessions/persistence/sessions.repository';
import { TasksService } from '../tasks/tasks.service';
import {
  buildGlobalTimeline,
  foldObservabilityRollups,
  foldObservabilitySummary,
  foldSessionObservability,
} from './observability-folds';
import type {
  ObservabilityMetrics,
  ObservabilityRollupDto,
  ObservabilitySources,
  RollupDimension,
  SessionObservabilityDto,
  TimelineEntryDto,
} from './observability.types';

@Injectable()
export class ObservabilityService {
  clock: Clock = { now: () => Date.now() };

  constructor(
    private readonly sessions: SessionsRepository,
    private readonly events: EventsRepository,
    private readonly tasks: TasksService,
    private readonly loops: LoopsRepository,
    private readonly attention: AttentionRepository,
    private readonly digests: DigestRepository,
  ) {}

  summary(from?: string, to?: string): ObservabilityMetrics {
    const now = this.clock.now();
    return foldObservabilitySummary(this.sources(), { window: this.window(from, to, now), now });
  }

  session(id: string, from?: string, to?: string): SessionObservabilityDto {
    const now = this.clock.now();
    return foldSessionObservability(this.sources(), id, { window: this.window(from, to, now), now });
  }

  rollups(dimension?: RollupDimension, from?: string, to?: string): ObservabilityRollupDto[] {
    const now = this.clock.now();
    return foldObservabilityRollups(this.sources(), { window: this.window(from, to, now), now }, dimension);
  }

  timeline(input: {
    from?: string;
    to?: string;
    projectPath?: string;
    provider?: string;
  } = {}): TimelineEntryDto[] {
    const now = this.clock.now();
    return buildGlobalTimeline(this.sources(), {
      window: this.window(input.from, input.to, now),
      now,
      ...(input.projectPath?.trim() ? { projectPath: input.projectPath.trim() } : {}),
      ...(input.provider?.trim() ? { provider: input.provider.trim() } : {}),
    });
  }

  private sources(): ObservabilitySources {
    const sessions = this.sessions.list(true);
    return {
      sessions,
      eventsBySession: Object.fromEntries(
        sessions.map((session) => [session.id, this.events.list(session.id)]),
      ),
      tasks: this.tasks.list(),
      loopRuns: this.loops.listAllRuns(),
      attentionItems: this.attention.list(),
      digestRuns: this.digests.list(),
    };
  }

  private window(from: string | undefined, to: string | undefined, now: number): { from: number; to: number } {
    const parsedFrom = parseNumber(from);
    const parsedTo = parseNumber(to);
    return {
      from: parsedFrom ?? 0,
      to: parsedTo ?? now + 1,
    };
  }
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
