import type { SessionEvent } from './api';

export interface VerifyStatus {
  state: 'running' | 'passed' | 'failed';
  command?: string;
  exitCode?: number | null;
  timedOut?: boolean;
}

/** The newest verify event wins unless a later lifecycle stop cancelled that run. */
export function deriveVerifyStatus(events: SessionEvent[]): VerifyStatus | null {
  let lifecycleStopped = false;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) continue;
    const payload = (event.payload ?? {}) as {
      command?: string;
      ok?: boolean;
      exitCode?: number | null;
      timedOut?: boolean;
      status?: string;
    };
    if (event.type === 'status') {
      lifecycleStopped = payload.status !== 'IDLE';
      continue;
    }
    if (event.type === 'verify_result') {
      return {
        state: payload.ok ? 'passed' : 'failed',
        ...(payload.command !== undefined ? { command: payload.command } : {}),
        ...(payload.exitCode !== undefined ? { exitCode: payload.exitCode } : {}),
        ...(payload.timedOut !== undefined ? { timedOut: payload.timedOut } : {}),
      };
    }
    if (event.type === 'verify_start') {
      if (lifecycleStopped) return null;
      return {
        state: 'running',
        ...(payload.command !== undefined ? { command: payload.command } : {}),
      };
    }
  }
  return null;
}
