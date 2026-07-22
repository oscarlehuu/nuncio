export interface SubmitLock {
  tryAcquire(): boolean;
  release(): void;
}

/**
 * Guards an async submit handler against duplicate taps: the first
 * {@link SubmitLock.tryAcquire} wins synchronously, the rest are rejected until
 * {@link SubmitLock.release} runs in the handler's `finally`.
 */
export function createSubmitLock(): SubmitLock {
  let locked = false;
  return {
    tryAcquire() {
      if (locked) return false;
      locked = true;
      return true;
    },
    release() {
      locked = false;
    },
  };
}
