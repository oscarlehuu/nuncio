import { describe, expect, it } from 'bun:test';
import { HubController } from '../../../src/hub/hub.controller';

describe('HubController', () => {
  it('returns an empty machine list when hub mode is disabled', async () => {
    const controller = new HubController(
      { enabled: () => false } as never,
      { discover: async () => [{ id: 'mac', name: 'Mac' }] } as never,
    );
    await expect(controller.machines()).resolves.toEqual({ hubMode: false, machines: [] });
  });

  it('discovers machines when hub mode is enabled', async () => {
    const machines = [
      { id: 'studio', name: 'Studio', baseUrl: 'https://studio.tail.ts.net' },
      { id: 'laptop', name: 'Laptop', baseUrl: 'https://laptop.tail.ts.net' },
    ];
    const controller = new HubController(
      { enabled: () => true } as never,
      { discover: async () => machines } as never,
    );
    await expect(controller.machines()).resolves.toEqual({ hubMode: true, machines });
  });
});
