import { describe, expect, it, jest } from 'bun:test';
import { RelayController } from '../../../src/relay/relay.controller';

describe('RelayController', () => {
  it('returns the exact per-path status and last-probe latency shape', async () => {
    const result = {
      lan: { status: 'up', latencyMs: 2, probedAt: 100 },
      tailnet: { status: 'up', latencyMs: 12, probedAt: 101 },
      funnel: { status: 'down', latencyMs: 48, probedAt: 102, reason: 'not configured' },
    } as const;
    const probeAll = jest.fn(async () => result);
    const controller = new RelayController({ probeAll } as never);
    await expect(controller.getHealth()).resolves.toEqual(result);
    expect(Object.keys(await controller.getHealth())).toEqual(['lan', 'tailnet', 'funnel']);
  });
});
