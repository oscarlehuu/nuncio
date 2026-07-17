import { TERMINAL_TASK_STATUSES, type TaskStatus } from './tasks.types';

/**
 * Overall state of a multitask fan-out, derived purely from its children:
 * - `coordinating` — no children yet (decompose in flight / none spawned).
 * - `working`      — at least one child is still QUEUED or RUNNING.
 * - `settled`      — every child reached a terminal state (a FAILED child does
 *                    NOT block settle; failure of one must not sink the board).
 */
type MultitaskOverall = 'coordinating' | 'working' | 'settled';

export interface MultitaskBoard {
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  /** Children not yet in a terminal state (queued + running). */
  working: number;
  /** Children in a terminal state (done + failed + cancelled). */
  settledCount: number;
  overall: MultitaskOverall;
}

/**
 * Project a multitask parent's board from its children's statuses. Pure: the
 * SAME function backs the "N working" footer, the "parent settled only after
 * children settle" contract, and the table-driven unit tests — one source of
 * truth for board state, no drift between UI and conformance.
 */
export function projectMultitaskBoard(children: ReadonlyArray<{ status: TaskStatus }>): MultitaskBoard {
  let queued = 0;
  let running = 0;
  let done = 0;
  let failed = 0;
  let cancelled = 0;

  for (const child of children) {
    switch (child.status) {
      case 'QUEUED':
        queued += 1;
        break;
      case 'RUNNING':
        running += 1;
        break;
      case 'DONE':
        done += 1;
        break;
      case 'FAILED':
        failed += 1;
        break;
      case 'CANCELLED':
        cancelled += 1;
        break;
    }
  }

  const total = children.length;
  const working = queued + running;
  const settledCount = done + failed + cancelled;
  const overall: MultitaskOverall =
    total === 0 ? 'coordinating' : working > 0 ? 'working' : 'settled';

  return { total, queued, running, done, failed, cancelled, working, settledCount, overall };
}

/** True when every child has reached a terminal state (or there are none). */
export function allChildrenSettled(children: ReadonlyArray<{ status: TaskStatus }>): boolean {
  return children.every((child) => TERMINAL_TASK_STATUSES.includes(child.status));
}
