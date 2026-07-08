import type {
  ObservabilityQuery,
  ObservabilityRollupDto,
  ObservabilitySources,
  RollupDimension,
} from './observability.types';
import type { TaskDto } from '../tasks/tasks.types';
import { foldSources } from './observability-metrics';
import { dayKey, projectKey } from './observability-utils';

export function foldObservabilityRollups(
  sources: ObservabilitySources,
  query: ObservabilityQuery,
  dimension?: RollupDimension,
): ObservabilityRollupDto[] {
  const dimensions: RollupDimension[] = dimension ? [dimension] : ['provider', 'project', 'day'];
  const rollups: ObservabilityRollupDto[] = [];
  for (const dim of dimensions) {
    for (const key of rollupKeys(sources, dim)) {
      rollups.push({
        dimension: dim,
        key,
        label: key,
        metrics: foldSources(filterSourcesByDimension(sources, dim, key), query),
      });
    }
  }
  return rollups.sort((a, b) => a.dimension.localeCompare(b.dimension) || a.key.localeCompare(b.key));
}

function rollupKeys(sources: ObservabilitySources, dimension: RollupDimension): string[] {
  const keys = new Set<string>();
  if (dimension === 'provider') {
    for (const session of sources.sessions) keys.add(session.provider);
    for (const task of sources.tasks) keys.add(task.provider ?? 'unknown');
  } else if (dimension === 'project') {
    keys.add('unassigned');
    for (const session of sources.sessions) keys.add(projectKey(session.projectPath));
    for (const task of sources.tasks) keys.add(projectKey(task.projectPath));
    for (const item of sources.attentionItems) keys.add(projectKey(item.projectPath));
  } else {
    for (const session of sources.sessions) keys.add(dayKey(session.createdAt));
    for (const task of sources.tasks) keys.add(dayKey(task.createdAt));
    for (const run of sources.loopRuns) keys.add(run.dayBucket || dayKey(run.createdAt));
    for (const item of sources.attentionItems) keys.add(dayKey(item.createdAt));
  }
  return [...keys].sort();
}

function filterSourcesByDimension(
  sources: ObservabilitySources,
  dimension: RollupDimension,
  key: string,
): ObservabilitySources {
  const sessions = sources.sessions.filter((session) =>
    dimension === 'provider' ? session.provider === key
      : dimension === 'project' ? projectKey(session.projectPath) === key
        : dayKey(session.createdAt) === key,
  );
  const sessionIds = new Set(sessions.map((session) => session.id));
  const tasks = sources.tasks.filter((task) => matchesTaskDimension(task, dimension, key));
  const tasksById = new Map(sources.tasks.map((task) => [task.id, task]));

  return {
    sessions,
    eventsBySession: Object.fromEntries(
      Object.entries(sources.eventsBySession).filter(([sessionId]) => sessionIds.has(sessionId)),
    ),
    tasks,
    loopRuns: sources.loopRuns.filter((run) => matchesLoopRunDimension(run, tasksById, dimension, key)),
    attentionItems: sources.attentionItems.filter((item) =>
      dimension === 'project' ? projectKey(item.projectPath) === key
        : dimension === 'day' ? dayKey(item.createdAt) === key
          : false,
    ),
    digestRuns: sources.digestRuns.filter((digest) =>
      dimension === 'day' ? dayKey(digest.sentAt) === key : false,
    ),
  };
}

function matchesTaskDimension(task: TaskDto, dimension: RollupDimension, key: string): boolean {
  if (dimension === 'provider') return (task.provider ?? 'unknown') === key;
  if (dimension === 'project') return projectKey(task.projectPath) === key;
  return dayKey(task.createdAt) === key;
}

function matchesLoopRunDimension(
  run: { taskId: string | null; dayBucket: string; createdAt: number },
  tasksById: Map<string, TaskDto>,
  dimension: RollupDimension,
  key: string,
): boolean {
  if (dimension === 'day') return (run.dayBucket || dayKey(run.createdAt)) === key;
  const task = run.taskId ? tasksById.get(run.taskId) : undefined;
  if (dimension === 'provider') return (task?.provider ?? 'unknown') === key;
  return projectKey(task?.projectPath ?? null) === key;
}
