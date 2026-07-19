import { describe, expect, it } from 'bun:test';
import { deadline } from './pi-provider-perf-harness.mjs';

describe('Pi provider performance deadline', () => {
  it('rejects a timed-out sample even when abort settles the measured run', async () => {
    let settleRun = () => undefined;
    const measuredRun = new Promise((resolve) => {
      settleRun = () => resolve('aborted-success');
    });

    const result = deadline(measuredRun, 1, async () => {
      settleRun();
    });

    await expect(result).rejects.toThrow('timed out');
  });

  it('bounds timeout cleanup when abort cannot settle the measured run', async () => {
    const neverSettles = new Promise(() => undefined);

    await expect(deadline(
      neverSettles,
      1,
      async () => new Promise(() => undefined),
      5,
    )).rejects.toThrow('timed out');
  });
});
