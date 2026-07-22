import { describe, expect, it } from 'vitest';
import { createSubmitLock } from './submit-lock';

describe('createSubmitLock', () => {
  it('locks duplicate taps synchronously until released', () => {
    const lock = createSubmitLock();
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.tryAcquire()).toBe(false);
    lock.release();
    expect(lock.tryAcquire()).toBe(true);
  });
});
