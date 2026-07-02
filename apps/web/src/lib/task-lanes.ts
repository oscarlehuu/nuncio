import type { VerifyStatus } from './derive-verify-status';
import type { Task } from './tasks-api';

export interface TaskLanes {
  queued: Task[];
  running: Task[];
  needsYou: Task[];
  done: Task[];
}

/** Inbox lanes: "needs you" wins over plain running; every terminal state lands in done. */
export function bucketTasks(tasks: Task[]): TaskLanes {
  const lanes: TaskLanes = { queued: [], running: [], needsYou: [], done: [] };
  for (const task of tasks) {
    if (task.status === 'QUEUED') lanes.queued.push(task);
    else if (task.status === 'RUNNING' && task.pendingInput) lanes.needsYou.push(task);
    else if (task.status === 'RUNNING') lanes.running.push(task);
    else lanes.done.push(task);
  }
  return lanes;
}

/** Map a finished task's recorded verify outcome onto the shared chip status. */
export function verifyStatusFromOutcome(
  outcome: Record<string, unknown> | null,
): VerifyStatus | null {
  const verify = outcome?.verify as
    | { ok?: boolean; exitCode?: number | null; timedOut?: boolean; command?: string }
    | undefined;
  if (!verify || typeof verify.ok !== 'boolean') return null;
  return {
    state: verify.ok ? 'passed' : 'failed',
    ...(verify.command !== undefined ? { command: verify.command } : {}),
    ...(verify.exitCode !== undefined ? { exitCode: verify.exitCode } : {}),
    ...(verify.timedOut !== undefined ? { timedOut: verify.timedOut } : {}),
  };
}
