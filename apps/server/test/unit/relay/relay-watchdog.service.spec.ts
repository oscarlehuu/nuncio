import { describe, expect, it, jest } from 'bun:test';
import { RelayWatchdogService } from '../../../src/relay/relay-watchdog.service';
import type { RelayHealthDto, RelayPathStatus } from '../../../src/relay/relay.types';
import type { FunnelResult } from '../../../src/tailscale/tailscale.service';

function path(status: RelayPathStatus, reason?: string) {
  return { status, latencyMs: 4, probedAt: 100, ...(reason ? { reason } : {}) };
}

function snapshot(funnel: RelayPathStatus): RelayHealthDto {
  return { lan: path('up'), tailnet: path('up'), funnel: path(funnel) };
}

function harness(results: RelayHealthDto[]) {
  const probeAll = jest.fn(async () => results.shift() ?? snapshot('unknown'));
  const enableFunnel = jest.fn(async (): Promise<FunnelResult> => ({ ok: false, reason: 'error' }));
  const raise = jest.fn(() => undefined);
  const onConditionCleared = jest.fn(() => undefined);
  const service = new RelayWatchdogService(
    { probeAll } as never,
    { enableFunnel } as never,
    { raise, onConditionCleared } as never,
  );
  return { service, probeAll, enableFunnel, raise, onConditionCleared };
}

describe('RelayWatchdogService', () => {
  it.each(['up', 'unknown'] as const)('never mutates a %s funnel', async (status) => {
    const h = harness([snapshot(status)]);
    await h.service.tick();
    expect(h.enableFunnel).not.toHaveBeenCalled();
    expect(h.raise).not.toHaveBeenCalled();
  });

  it('does not enable a funnel that has never been observed up', async () => {
    const h = harness([snapshot('down')]);
    await h.service.tick();
    expect(h.enableFunnel).not.toHaveBeenCalled();
    expect(h.raise).not.toHaveBeenCalled();
  });

  it('re-enables a previously-up funnel after it drops and confirms recovery', async () => {
    const h = harness([snapshot('up'), snapshot('down'), snapshot('up')]);
    h.enableFunnel.mockResolvedValue({ ok: true });
    await h.service.tick();
    await h.service.tick();
    expect(h.enableFunnel).toHaveBeenCalledTimes(1);
    expect(h.enableFunnel).toHaveBeenCalledWith(3000);
    expect(h.onConditionCleared).toHaveBeenCalledWith('relay-down', 'funnel');
    expect(h.raise).not.toHaveBeenCalled();
  });

  it('does not act when the funnel is down but tailnet is not proven up', async () => {
    const down = snapshot('down');
    down.tailnet = path('unknown');
    const h = harness([snapshot('up'), down]);
    await h.service.tick();
    await h.service.tick();
    expect(h.enableFunnel).not.toHaveBeenCalled();
  });

  it('raises one dedupable attention condition after persistent restoration failure', async () => {
    const h = harness([snapshot('up'), snapshot('down'), snapshot('down')]);
    h.service.failureThreshold = 2;
    await h.service.tick();
    await h.service.tick();
    await h.service.tick();
    expect(h.enableFunnel).toHaveBeenCalledTimes(2);
    expect(h.raise).toHaveBeenCalledTimes(1);
    expect(h.raise).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'relay-down', subjectId: 'funnel',
      payload: expect.objectContaining({ attempts: 2, path: 'funnel' }),
    }));
  });

  it('preserves accumulated failures across an unknown probe', async () => {
    const h = harness([snapshot('up'), snapshot('down'), snapshot('unknown'), snapshot('down')]);
    h.service.failureThreshold = 2;
    await h.service.tick();
    await h.service.tick();
    await h.service.tick();
    await h.service.tick();
    expect(h.raise).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'relay-down', payload: expect.objectContaining({ attempts: 2 }),
    }));
  });

  it('keeps a raised relay-down alert through unknown and clears it only on up', async () => {
    const h = harness([snapshot('up'), snapshot('down'), snapshot('unknown'), snapshot('up')]);
    h.service.failureThreshold = 1;
    await h.service.tick();
    h.onConditionCleared.mockClear();
    await h.service.tick();
    expect(h.raise).toHaveBeenCalledTimes(1);

    await h.service.tick();
    expect(h.raise).toHaveBeenCalledTimes(1);
    expect(h.onConditionCleared).not.toHaveBeenCalled();

    await h.service.tick();
    expect(h.onConditionCleared).toHaveBeenCalledWith('relay-down', 'funnel');
  });

  it('does not overlap probes or issue duplicate recovery commands', async () => {
    let release!: (value: RelayHealthDto) => void;
    const probeAll = jest.fn(() => new Promise<RelayHealthDto>((resolve) => { release = resolve; }));
    const enableFunnel = jest.fn(async (): Promise<FunnelResult> => ({ ok: false, reason: 'error' }));
    const service = new RelayWatchdogService(
      { probeAll } as never, { enableFunnel } as never,
      { raise: jest.fn(), onConditionCleared: jest.fn() } as never,
    );
    const first = service.tick();
    const second = service.tick();
    release(snapshot('up'));
    await Promise.all([first, second]);
    expect(probeAll).toHaveBeenCalledTimes(1);
    expect(enableFunnel).not.toHaveBeenCalled();
  });

  it('never starts recovery after module teardown begins', async () => {
    let release!: (value: RelayHealthDto) => void;
    const probeAll = jest.fn(() => new Promise<RelayHealthDto>((resolve) => { release = resolve; }));
    const enableFunnel = jest.fn(async (): Promise<FunnelResult> => ({ ok: true }));
    const service = new RelayWatchdogService(
      { probeAll } as never, { enableFunnel } as never,
      { raise: jest.fn(), onConditionCleared: jest.fn() } as never,
    );
    const tick = service.tick();
    service.onModuleDestroy();
    release(snapshot('down'));
    await tick;
    expect(enableFunnel).not.toHaveBeenCalled();
  });

  it('counts thrown recovery errors toward persistent-failure attention', async () => {
    const h = harness([snapshot('up'), snapshot('down')]);
    h.service.failureThreshold = 1;
    h.enableFunnel.mockRejectedValue(new Error('spawn denied'));
    await h.service.tick();
    await h.service.tick();
    expect(h.raise).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'relay-down', payload: expect.objectContaining({ reason: 'spawn denied' }),
    }));
  });
});
