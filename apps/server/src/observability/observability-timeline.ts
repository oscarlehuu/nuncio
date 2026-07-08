import type { ObservabilitySources, TimelineEntryDto, TimelineQuery } from './observability.types';
import type { AttentionItemDto } from '../attention/attention.types';
import type { LoopRunDto } from '../loops/loops.types';
import type { SessionDto, SessionEvent } from '../sessions/domain/sessions.types';
import type { TaskDto } from '../tasks/tasks.types';
import { compareTimelineEntries } from './observability-timeline-significance';
import { inWindow, payloadRecord } from './observability-utils';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function buildGlobalTimeline(
  sources: ObservabilitySources,
  query: TimelineQuery,
): TimelineEntryDto[] {
  const tasksById = new Map(sources.tasks.map((task) => [task.id, task]));
  const entries: TimelineEntryDto[] = [];

  for (const session of sources.sessions) appendSessionFacts(session, sources.eventsBySession[session.id] ?? [], entries);
  for (const task of sources.tasks) appendTaskFact(task, entries);
  for (const run of sources.loopRuns) appendLoopRunFact(run, tasksById.get(run.taskId ?? ''), entries);
  for (const item of sources.attentionItems) appendAttentionFacts(item, entries);
  for (const digest of sources.digestRuns) {
    entries.push(entry({
      id: `digest:${digest.slotKey}`,
      ts: digest.sentAt,
      kind: 'digest-sent',
      title: `${digest.variant} digest sent`,
      projectPath: null,
      provider: null,
    }));
  }

  const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  return entries
    .filter((item) => inWindow(item.ts, query))
    .filter((item) => (query.before === undefined ? true : item.ts < query.before!))
    .filter((item) => (query.provider ? item.provider === query.provider : true))
    .filter((item) => (query.projectPath ? item.projectPath === query.projectPath : true))
    .sort(compareTimelineEntries)
    .slice(0, limit);
}

function appendSessionFacts(session: SessionDto, events: SessionEvent[], entries: TimelineEntryDto[]): void {
  entries.push(entry({
    id: `session-started:${session.id}`,
    ts: session.createdAt,
    kind: 'session-started',
    title: `Started ${session.title}`,
    projectPath: session.projectPath ?? null,
    provider: session.provider,
    sessionId: session.id,
  }));

  if (session.pendingInput) {
    entries.push(entry({
      id: `session-needs-you:${session.id}:pending-input`,
      ts: session.updatedAt,
      kind: 'session-needs-you',
      title: `${session.title} needs you`,
      projectPath: session.projectPath ?? null,
      provider: session.provider,
      sessionId: session.id,
    }));
  }

  if (session.pullRequestUrl && session.pullRequestState !== 'closed') {
    entries.push(entry({
      id: `pr-opened:${session.id}:${session.pullRequestNumber ?? session.pullRequestUrl}`,
      ts: session.updatedAt,
      kind: 'pr-opened-detected',
      title: `PR opened for ${session.title}`,
      projectPath: session.projectPath ?? null,
      provider: session.provider,
      sessionId: session.id,
      prUrl: session.pullRequestUrl,
    }));
  }

  for (const event of events) {
    if (event.type === 'status') appendStatusFact(session, event, entries);
    if (event.type === 'verify_needs_attention') {
      entries.push(entry({
        id: `session-needs-you:${session.id}:${event.seq}`,
        ts: event.createdAt,
        kind: 'session-needs-you',
        title: `${session.title} needs you`,
        projectPath: session.projectPath ?? null,
        provider: session.provider,
        sessionId: session.id,
      }));
    }
  }
}

function appendStatusFact(session: SessionDto, event: SessionEvent, entries: TimelineEntryDto[]): void {
  const status = payloadRecord(event).status;
  if (status !== 'IDLE' && status !== 'ARCHIVED') return;
  entries.push(entry({
    id: `session-completed:${session.id}:${event.seq}`,
    ts: event.createdAt,
    kind: 'session-completed',
    title: `Completed ${session.title}`,
    projectPath: session.projectPath ?? null,
    provider: session.provider,
    sessionId: session.id,
  }));
}

function appendTaskFact(task: TaskDto, entries: TimelineEntryDto[]): void {
  if ((task.status !== 'DONE' && task.status !== 'FAILED') || task.finishedAt === null) return;
  const kind = task.status === 'DONE' ? 'task-done' : 'task-failed';
  entries.push(entry({
    id: `${kind}:${task.id}`,
    ts: task.finishedAt,
    kind,
    title: task.status === 'DONE' ? `Task done: ${task.prompt}` : `Task failed: ${task.prompt}`,
    projectPath: task.projectPath ?? null,
    provider: task.provider ?? null,
    taskId: task.id,
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    outcome: task.status,
  }));
}

function appendLoopRunFact(run: LoopRunDto, task: TaskDto | undefined, entries: TimelineEntryDto[]): void {
  if (run.outcome === 'pending') return;
  entries.push(entry({
    id: `loop-run-settled:${run.id}`,
    ts: run.createdAt,
    kind: 'loop-run-settled',
    title: `Loop run ${run.outcome}${run.verify !== 'none' ? ` (${run.verify})` : ''}`,
    projectPath: task?.projectPath ?? null,
    provider: task?.provider ?? null,
    taskId: run.taskId ?? undefined,
    loopId: run.loopId,
    outcome: run.outcome,
    verify: run.verify,
  }));
}

function appendAttentionFacts(item: AttentionItemDto, entries: TimelineEntryDto[]): void {
  const subjectLoopId = item.subjectId.startsWith('loop:') ? item.subjectId.slice('loop:'.length) : item.subjectId;
  if (item.kind === 'tripped-breaker') {
    entries.push(entry({
      id: `breaker-tripped:${item.id}`,
      ts: item.createdAt,
      kind: 'breaker-tripped',
      title: item.title,
      projectPath: item.projectPath ?? null,
      provider: null,
      loopId: subjectLoopId,
      attentionId: item.id,
      severity: item.severity,
    }));
    if (item.resolvedAt !== null) {
      entries.push(entry({
        id: `breaker-resumed:${item.id}`,
        ts: item.resolvedAt,
        kind: 'breaker-resumed',
        title: `Resolved ${item.title}`,
        projectPath: item.projectPath ?? null,
        provider: null,
        loopId: subjectLoopId,
        attentionId: item.id,
        severity: item.severity,
      }));
    }
    return;
  }

  entries.push(entry({
    id: `attention-raised:${item.id}`,
    ts: item.createdAt,
    kind: 'attention-raised',
    title: item.title,
    projectPath: item.projectPath ?? null,
    provider: null,
    attentionId: item.id,
    severity: item.severity,
  }));
  if (item.resolvedAt !== null) {
    entries.push(entry({
      id: `attention-resolved:${item.id}`,
      ts: item.resolvedAt,
      kind: 'attention-resolved',
      title: `Resolved ${item.title}`,
      projectPath: item.projectPath ?? null,
      provider: null,
      attentionId: item.id,
      severity: item.severity,
    }));
  }
}

function entry(input: Omit<TimelineEntryDto, 'at'>): TimelineEntryDto {
  return { ...input, at: input.ts };
}
