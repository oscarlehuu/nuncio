import { describe, expect, it } from 'bun:test';
import { FleetController } from '../../../../src/attention/fleet/fleet.controller';
import type { FleetService } from '../../../../src/attention/fleet/fleet.service';
import type { FleetRow } from '../../../../src/attention/fleet/fleet.types';

/** GET /fleet contract (rung 3 sub-phase C) — RED until FleetService is implemented. */
describe('FleetController', () => {
  it('GET /fleet wraps the ordered rows in an { items } envelope', async () => {
    const rows: FleetRow[] = [
      {
        path: '/p', name: 'p', weight: 1, health: 'green', reasons: [], topItem: null,
        counts: { openAttention: 0, runningSessions: 0, activeLoops: 0, openPRs: 0 },
        lastActivityAt: null,
      },
    ];
    const fleet = { list: async () => rows } as unknown as FleetService;
    const controller = new FleetController(fleet);
    expect(await controller.list()).toEqual({ items: rows });
  });
});
