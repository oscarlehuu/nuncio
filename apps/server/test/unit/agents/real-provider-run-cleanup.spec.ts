import { describe, expect, it } from 'bun:test';
import { settleRealProviderRun } from '../../helpers/real-provider-run-cleanup';

describe('real-provider integration cleanup', () => {
  it('waits for the interrupted run to settle before returning', async () => {
    let settleRun: () => void = () => undefined;
    let runSettled = false;
    const run = new Promise<void>((resolve) => {
      settleRun = resolve;
    });
    void run.then(() => {
      runSettled = true;
    });

    await settleRealProviderRun(run, async () => {
      setTimeout(settleRun, 5);
    }, 100);

    expect(runSettled).toBe(true);
  });

  it('fails clearly when the interrupted run cannot settle before teardown', async () => {
    const neverSettles = new Promise<void>(() => undefined);

    await expect(settleRealProviderRun(
      neverSettles,
      async () => undefined,
      5,
    )).rejects.toThrow('did not settle');
  });

  it('bounds cleanup when the interrupt acknowledgement itself hangs', async () => {
    const outcome = await Promise.race([
      settleRealProviderRun(
        new Promise<void>(() => undefined),
        async () => new Promise<void>(() => undefined),
        5,
      ).then(() => 'resolved', () => 'rejected'),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 30)),
    ]);

    expect(outcome).toBe('rejected');
  });
});
