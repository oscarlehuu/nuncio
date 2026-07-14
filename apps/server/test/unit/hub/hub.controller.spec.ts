import { describe, expect, it } from 'bun:test';
import { HubController } from '../../../src/hub/hub.controller';
import type { MachineEntry } from '../../../src/hub/hub-registry.service';

describe('HubController', () => {
  it('returns an empty machine list when hub mode is disabled', async () => {
    const controller = new HubController(
      { enabled: () => false } as never,
      { discover: async () => [{ id: 'mac', name: 'Mac' }] } as never,
    );
    await expect(controller.machines()).resolves.toEqual({ hubMode: false, machines: [] });
  });

  it('discovers machines when hub mode is enabled', async () => {
    const machines: MachineEntry[] = [
      {
        name: 'studio',
        dnsName: 'studio.tail.ts.net',
        origin: 'https://studio.tail.ts.net',
        os: 'darwin',
        self: false,
      },
      {
        name: 'laptop',
        dnsName: 'laptop.tail.ts.net',
        origin: 'https://laptop.tail.ts.net',
        os: 'darwin',
        self: true,
      },
    ];
    const controller = new HubController(
      { enabled: () => true } as never,
      { discover: async () => machines } as never,
    );
    await expect(controller.machines()).resolves.toEqual({ hubMode: true, machines });
  });
});
