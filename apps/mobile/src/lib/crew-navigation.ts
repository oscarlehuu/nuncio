import type { NotificationTarget } from './push-registration';

export type MobileNavigationPath = `/crew/${string}` | `/session/${string}`;

export function crewTaskPath(taskId: string, runId?: string | null): `/crew/${string}` {
  const taskPath = `/crew/${encodeURIComponent(taskId)}` as const;
  return runId ? `${taskPath}?run=${encodeURIComponent(runId)}` : taskPath;
}

export function notificationPath(target: NotificationTarget): MobileNavigationPath {
  return target.kind === 'crew'
    ? crewTaskPath(target.taskId, target.runId)
    : `/session/${encodeURIComponent(target.sessionId)}`;
}
