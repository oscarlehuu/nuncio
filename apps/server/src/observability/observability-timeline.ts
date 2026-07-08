import type { ObservabilitySources, TimelineEntryDto, TimelineQuery } from './observability.types';
import type { SessionEvent } from '../sessions/domain/sessions.types';
import { inWindow, verifyOk } from './observability-utils';

const KIND_ORDER: Record<string, number> = {
  session: 0,
  task: 1,
  'loop-run': 2,
  attention: 3,
  digest: 4,
  steer: 5,
  verify: 6,
};

export function buildGlobalTimeline(
  sources: ObservabilitySources,
  query: TimelineQuery,
): TimelineEntryDto[] {
  const tasksById = new Map(sources.tasks.map((task) => [task.id, task]));
  const entries: TimelineEntryDto[] = [];

  for (const session of sources.sessions) {
    entries.push({
      id: `session:${session.id}`,
      at: session.createdAt,
      kind: 'session',
      title: session.title,
      projectPath: session.projectPath ?? null,
      provider: session.provider,
      sessionId: session.id,
    });
  }

  for (const task of sources.tasks) {
    entries.push({
      id: `task:${task.id}`,
      at: task.createdAt,
      kind: 'task',
      title: task.prompt,
      projectPath: task.projectPath ?? null,
      provider: task.provider ?? null,
      taskId: task.id,
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    });
  }

  for (const run of sources.loopRuns) {
    const task = run.taskId ? tasksById.get(run.taskId) : undefined;
    entries.push({
      id: `loop-run:${run.id}`,
      at: run.createdAt,
      kind: 'loop-run',
      title: `Loop run ${run.outcome}`,
      projectPath: task?.projectPath ?? null,
      provider: task?.provider ?? null,
      taskId: run.taskId ?? undefined,
      loopId: run.loopId,
    });
  }

  for (const item of sources.attentionItems) {
    entries.push({
      id: `attention:${item.id}`,
      at: item.createdAt,
      kind: 'attention',
      title: item.title,
      projectPath: item.projectPath ?? null,
      provider: null,
      severity: item.severity,
    });
  }

  for (const digest of sources.digestRuns) {
    entries.push({
      id: `digest:${digest.slotKey}`,
      at: digest.sentAt,
      kind: 'digest',
      title: `${digest.variant} digest`,
      projectPath: null,
      provider: null,
    });
  }

  appendSessionEventFacts(sources, entries);
  return entries
    .filter((entry) => inWindow(entry.at, query))
    .filter((entry) => (query.provider ? entry.provider === query.provider : true))
    .filter((entry) => (query.projectPath ? entry.projectPath === query.projectPath : true))
    .sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id));
}

function appendSessionEventFacts(sources: ObservabilitySources, entries: TimelineEntryDto[]): void {
  for (const session of sources.sessions) {
    for (const event of sources.eventsBySession[session.id] ?? []) {
      if (event.type !== 'steer_message' && event.type !== 'verify_result') continue;
      entries.push({
        id: `${event.type}:${session.id}:${event.seq}`,
        at: event.createdAt,
        kind: event.type === 'steer_message' ? 'steer' : 'verify',
        title: event.type === 'steer_message' ? 'Steer sent' : verifyTitle(event),
        projectPath: session.projectPath ?? null,
        provider: session.provider,
        sessionId: session.id,
      });
    }
  }
}

function verifyTitle(event: SessionEvent): string {
  return verifyOk(event) ? 'Verify passed' : 'Verify failed';
}
