import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOLD_SECONDS,
  holdProgress,
  holdSecondsRemaining,
  isHeldTask,
} from './subagent-hold';
import type { TaskDto } from './api';

function task(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: 't1',
    status: 'QUEUED',
    holdUntil: null,
    ...overrides,
  } as TaskDto;
}

describe('subagent-hold', () => {
  it('exports the default hold window', () => {
    expect(DEFAULT_HOLD_SECONDS).toBe(15);
  });

  describe('isHeldTask', () => {
    it('is true only for QUEUED tasks with a future holdUntil', () => {
      expect(isHeldTask(task({ status: 'QUEUED', holdUntil: 2000 }), 1000)).toBe(true);
      expect(isHeldTask(task({ status: 'QUEUED', holdUntil: 500 }), 1000)).toBe(false);
      expect(isHeldTask(task({ status: 'QUEUED', holdUntil: null }), 1000)).toBe(false);
      expect(isHeldTask(task({ status: 'RUNNING', holdUntil: 2000 }), 1000)).toBe(false);
    });
  });

  describe('holdSecondsRemaining', () => {
    it('returns 0 when holdUntil is missing', () => {
      expect(holdSecondsRemaining(task({ holdUntil: null }), 1000)).toBe(0);
    });

    it('ceils remaining seconds and floors at 0', () => {
      expect(holdSecondsRemaining(task({ holdUntil: 2500 }), 1000)).toBe(2);
      expect(holdSecondsRemaining(task({ holdUntil: 1001 }), 1000)).toBe(1);
      expect(holdSecondsRemaining(task({ holdUntil: 500 }), 1000)).toBe(0);
    });
  });

  describe('holdProgress', () => {
    it('returns 1 when maxRemaining is non-positive', () => {
      expect(holdProgress(5, 0)).toBe(1);
      expect(holdProgress(0, -1)).toBe(1);
    });

    it('scales elapsed against maxRemaining without jumping backwards', () => {
      expect(holdProgress(15, 15)).toBe(0);
      expect(holdProgress(7.5, 15)).toBe(0.5);
      expect(holdProgress(0, 15)).toBe(1);
      expect(holdProgress(-1, 15)).toBe(1);
      expect(holdProgress(20, 15)).toBe(0);
    });
  });
});
