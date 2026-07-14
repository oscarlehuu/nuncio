import type { SessionStatus } from './api';

export type StatusDotTone =
  | 'hidden'
  | 'neutral'
  | 'running'
  | 'warning'
  | 'error'
  | 'archived';

/** Maps session run-state (+ pending input override) to a visual tone token. */
export function deriveStatusDotTone(status: SessionStatus, pending: boolean): StatusDotTone {
  if (pending) return 'warning';

  switch (status) {
    case 'IDLE':
      return 'hidden';
    case 'RUNNING':
      return 'running';
    case 'ERROR':
      return 'error';
    case 'ARCHIVED':
      return 'archived';
    case 'CREATED':
    case 'PAUSED':
      return 'neutral';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
