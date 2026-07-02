import { describe, it, expect } from 'vitest';
import { deriveVerifyStatus } from './derive-verify-status';
import type { SessionEvent } from './api';

function ev(seq: number, type: string, payload: Record<string, unknown> = {}): SessionEvent {
  return { seq, type, payload, createdAt: seq };
}

describe('deriveVerifyStatus', () => {
  it('returns null when no verify events exist', () => {
    expect(deriveVerifyStatus([ev(1, 'user_message', { text: 'hi' })])).toBeNull();
  });

  it('reports running while a verify_start has no later result', () => {
    const status = deriveVerifyStatus([
      ev(1, 'status', { status: 'IDLE' }),
      ev(2, 'verify_start', { command: 'bun test' }),
    ]);
    expect(status).toEqual({ state: 'running', command: 'bun test' });
  });

  it('reports the outcome of the latest verify_result', () => {
    const events = [
      ev(1, 'verify_start', { command: 'bun test' }),
      ev(2, 'verify_result', { command: 'bun test', ok: false, exitCode: 1, timedOut: false }),
      ev(3, 'verify_start', { command: 'bun test' }),
      ev(4, 'verify_result', { command: 'bun test', ok: true, exitCode: 0, timedOut: false }),
    ];
    expect(deriveVerifyStatus(events)).toEqual({
      state: 'passed',
      command: 'bun test',
      exitCode: 0,
      timedOut: false,
    });
    expect(deriveVerifyStatus(events.slice(0, 2))).toEqual({
      state: 'failed',
      command: 'bun test',
      exitCode: 1,
      timedOut: false,
    });
  });

  it('a new verify_start supersedes an older result', () => {
    const status = deriveVerifyStatus([
      ev(1, 'verify_result', { command: 'bun test', ok: true, exitCode: 0, timedOut: false }),
      ev(2, 'verify_start', { command: 'bun test' }),
    ]);
    expect(status?.state).toBe('running');
  });
});
