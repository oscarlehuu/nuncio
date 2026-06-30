import { describe, expect, it } from 'vitest';
import type { SessionEvent } from './api';
import { derivePendingUserInput } from './derive-pending-user-input';

function ev(seq: number, type: string, payload: Record<string, unknown>): SessionEvent {
  return { seq, type, payload, createdAt: seq * 1000 };
}

const questions = [{ id: 'q1', prompt: 'Pick', options: [{ id: 'a', label: 'A' }] }];

describe('derivePendingUserInput', () => {
  it('returns open requests without a matching resolved event', () => {
    const pending = derivePendingUserInput([
      ev(1, 'user_input_requested', { requestId: 'r1', questions, title: 'Title' }),
    ]);
    expect(pending).toEqual([
      { requestId: 'r1', createdAt: 1000, title: 'Title', questions },
    ]);
  });

  it('removes resolved requests', () => {
    const pending = derivePendingUserInput([
      ev(1, 'user_input_requested', { requestId: 'r1', questions }),
      ev(2, 'user_input_resolved', { requestId: 'r1', resolvedBy: 'user' }),
    ]);
    expect(pending).toEqual([]);
  });

  it('sorts by createdAt ascending', () => {
    const pending = derivePendingUserInput([
      ev(2, 'user_input_requested', { requestId: 'r2', questions }),
      ev(1, 'user_input_requested', { requestId: 'r1', questions }),
    ]);
    expect(pending.map((p) => p.requestId)).toEqual(['r1', 'r2']);
  });

  it('skips malformed events', () => {
    expect(derivePendingUserInput([ev(1, 'user_input_requested', { questions })])).toEqual([]);
    expect(derivePendingUserInput([ev(1, 'user_input_requested', { requestId: 'r1' })])).toEqual([]);
  });
});
