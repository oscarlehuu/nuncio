import { describe, expect, it } from 'vitest';
import type { SessionStatus } from './api';
import { deriveStatusDotTone } from './derive-status-dot-tone';

const STATUSES: SessionStatus[] = [
  'CREATED',
  'RUNNING',
  'IDLE',
  'PAUSED',
  'ARCHIVED',
  'ERROR',
];

describe('deriveStatusDotTone', () => {
  it.each([
    ['CREATED', 'neutral'],
    ['RUNNING', 'running'],
    ['IDLE', 'hidden'],
    ['PAUSED', 'neutral'],
    ['ARCHIVED', 'archived'],
    ['ERROR', 'error'],
  ] as const)('maps %s to %s when not pending', (status, tone) => {
    expect(deriveStatusDotTone(status, false)).toBe(tone);
  });

  it('pending overrides any status with warning', () => {
    for (const status of STATUSES) {
      expect(deriveStatusDotTone(status, true)).toBe('warning');
    }
  });
});
