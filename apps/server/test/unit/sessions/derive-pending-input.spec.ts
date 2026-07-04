import { deriveHasPendingInput } from '../../../src/sessions/domain/derive-pending-input';
import type { SessionEvent } from '../../../src/sessions/domain/sessions.types';

function ev(seq: number, type: string, payload: Record<string, unknown>): SessionEvent {
  return { seq, type, payload, createdAt: seq };
}

describe('deriveHasPendingInput', () => {
  it('is false for an empty tail', () => {
    expect(deriveHasPendingInput([])).toBe(false);
  });

  it('is true while a user-input request is unresolved', () => {
    expect(deriveHasPendingInput([ev(1, 'user_input_requested', { requestId: 'r1' })])).toBe(true);
  });

  it('is false once the request resolves', () => {
    expect(
      deriveHasPendingInput([
        ev(1, 'user_input_requested', { requestId: 'r1' }),
        ev(2, 'user_input_resolved', { requestId: 'r1' }),
      ]),
    ).toBe(false);
  });

  it('tracks provider (approval) requests too', () => {
    expect(deriveHasPendingInput([ev(1, 'provider_request', { requestId: 'p1' })])).toBe(true);
    expect(
      deriveHasPendingInput([
        ev(1, 'provider_request', { requestId: 'p1' }),
        ev(2, 'provider_request_resolved', { requestId: 'p1' }),
      ]),
    ).toBe(false);
  });

  it('stays true when one of several requests is still open', () => {
    expect(
      deriveHasPendingInput([
        ev(1, 'user_input_requested', { requestId: 'r1' }),
        ev(2, 'provider_request', { requestId: 'p1' }),
        ev(3, 'user_input_resolved', { requestId: 'r1' }),
      ]),
    ).toBe(true);
  });

  it('ignores events without a requestId', () => {
    expect(
      deriveHasPendingInput([
        ev(1, 'assistant_message', { text: 'hi' }),
        ev(2, 'user_input_requested', {}),
      ]),
    ).toBe(false);
  });
});
