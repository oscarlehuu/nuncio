/** Pure helpers for the per-task launch grace window ("hold"). A held task is
 *  QUEUED with a future holdUntil; it counts down client-side and starts on its
 *  own once the server flips it to RUNNING. */

import type { TaskDto } from './api';

/** Default re-arm window when the server's configured countdown isn't known to
 *  the client (the setting is server-side). Kept in sync with the backend
 *  default NUNCIO_MULTITASK_COUNTDOWN_SECONDS. */
export const DEFAULT_HOLD_SECONDS = 15;

export function isHeldTask(task: TaskDto, now: number): boolean {
  return task.status === 'QUEUED' && task.holdUntil != null && task.holdUntil > now;
}

/** Whole seconds remaining, floored at 0. */
export function holdSecondsRemaining(task: TaskDto, now: number): number {
  if (task.holdUntil == null) return 0;
  return Math.max(0, Math.ceil((task.holdUntil - now) / 1000));
}

/** Progress fraction (0..1) of the window elapsed, scaled against the largest
 *  remaining time we've seen for this task. We don't get the original window
 *  length from the server, so tracking the max-remaining-seen gives a stable
 *  denominator that never makes the bar jump backwards on a re-arm. */
export function holdProgress(remaining: number, maxRemaining: number): number {
  if (maxRemaining <= 0) return 1;
  const elapsed = maxRemaining - remaining;
  return Math.min(1, Math.max(0, elapsed / maxRemaining));
}
