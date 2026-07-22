import { describe, expect, it } from 'vitest';
import type { SessionStatus } from './api';
import { deriveComposerEnabled } from './derive-composer-enabled';

function input(
  overrides: Partial<{
    status: SessionStatus;
    steering: boolean;
    lifecycleBusy: boolean;
    hasPendingUserInput: boolean;
  }> = {},
) {
  return {
    status: 'IDLE' as SessionStatus,
    steering: false,
    lifecycleBusy: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

describe('deriveComposerEnabled', () => {
  it('enables the composer on a happy IDLE session', () => {
    expect(deriveComposerEnabled(input({ status: 'IDLE' }))).toEqual({ enabled: true });
  });

  it('does not disable when status is RUNNING alone (steerWhileRunning is orthogonal)', () => {
    expect(deriveComposerEnabled(input({ status: 'RUNNING' }))).toEqual({ enabled: true });
  });

  it('disables when the session is ARCHIVED', () => {
    expect(deriveComposerEnabled(input({ status: 'ARCHIVED' }))).toEqual({
      enabled: false,
      reason: 'archived',
    });
  });

  it('disables while pending user input is unresolved', () => {
    expect(deriveComposerEnabled(input({ hasPendingUserInput: true }))).toEqual({
      enabled: false,
      reason: 'pending_user_input',
    });
  });

  it('disables while a steer is in flight', () => {
    expect(deriveComposerEnabled(input({ steering: true }))).toEqual({
      enabled: false,
      reason: 'steering',
    });
  });

  it('disables while lifecycle actions are busy', () => {
    expect(deriveComposerEnabled(input({ lifecycleBusy: true }))).toEqual({
      enabled: false,
      reason: 'lifecycle_busy',
    });
  });

  it('ARCHIVED wins over other enable signals', () => {
    expect(
      deriveComposerEnabled(input({ status: 'ARCHIVED', steering: false })),
    ).toEqual({ enabled: false, reason: 'archived' });
  });
});
