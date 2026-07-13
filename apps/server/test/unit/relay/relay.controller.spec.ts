import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RelayController } from '../../../src/relay/relay.controller';
import { CandidateUrlsService } from '../../../src/pairing/candidate-urls.service';
import { DevicesService } from '../../../src/devices/devices.service';
import { ConnectionTicketService } from '../../../src/relay/connection-ticket.service';
import { RelayHealthService } from '../../../src/relay/relay-health.service';

const ladder = {
  urls: ['http://192.168.1.8:3000', 'https://mac.tailnet.ts.net'],
  hints: [],
  endpoints: {
    lan: ['http://192.168.1.8:3000'],
    tailnet: 'https://mac.tailnet.ts.net',
    funnel: 'https://mac.tailnet.ts.net',
  },
};

const healthResult = {
  lan: { status: 'up', latencyMs: 2, probedAt: 100 },
  tailnet: { status: 'up', latencyMs: 12, probedAt: 101 },
  funnel: { status: 'down', latencyMs: 48, probedAt: 102, reason: 'not configured' },
} as const;

function makeController(
  health: Partial<RelayHealthService> = { probeAll: async () => healthResult as never },
) {
  const candidates = { discover: async () => ladder.endpoints } as unknown as CandidateUrlsService;
  const devices = {
    verifyDevice: (id: string, secret: string) => id === 'device-1' && secret === 'good',
  } as unknown as DevicesService;
  const tickets = {
    mint: (deviceId: string) => ({ ticket: `rt1.${deviceId}.signed`, expiresAt: 1_700_000_060_000 }),
    verify: (ticket: string, scope: string) =>
      ticket === 'rt1.valid.signed' && scope === 'relay:endpoints'
        ? { deviceId: 'device-1' }
        : null,
  } as unknown as ConnectionTicketService;
  const controller = new RelayController(
    candidates,
    devices,
    tickets,
    health as unknown as RelayHealthService,
  );
  controller.setClock(() => 1_700_000_000_000);
  return controller;
}

describe('RelayController', () => {
  it('mints a ticket only from an existing device bearer and keeps response exact', () => {
    const controller = makeController();
    expect(controller.ticket({ headers: { authorization: 'Bearer nd1.device-1.good' } })).toEqual({
      ticket: 'rt1.device-1.signed',
      expiresAt: 1_700_000_060_000,
    });
    expect(() => controller.ticket({ headers: { authorization: 'Bearer rt1.valid.signed' } }))
      .toThrow(UnauthorizedException);
  });

  it('returns the live ladder to an existing device bearer', async () => {
    const controller = makeController();
    expect(await controller.endpoints({
      headers: { authorization: 'Bearer nd1.device-1.good' },
    })).toEqual({ ...ladder.endpoints, updatedAt: 1_700_000_000_000 });
  });

  it('returns the same exact shape to a valid connection ticket', async () => {
    const controller = makeController();
    const result = await controller.endpoints({
      headers: { authorization: 'Bearer rt1.valid.signed' },
    });
    expect(Object.keys(result)).toEqual(['lan', 'tailnet', 'funnel', 'updatedAt']);
    expect(result).toEqual({ ...ladder.endpoints, updatedAt: 1_700_000_000_000 });
  });

  it('rejects missing, malformed, and invalid credentials', async () => {
    const controller = makeController();
    for (const authorization of [undefined, 'Bearer nd1.device-1.stale', 'Bearer rt1.bad.signed']) {
      await expect(controller.endpoints({ headers: { authorization } })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
  });

  it('returns the exact per-path status and last-probe latency shape', async () => {
    const controller = makeController();
    await expect(controller.getHealth()).resolves.toEqual(healthResult);
    expect(Object.keys(await controller.getHealth())).toEqual(['lan', 'tailnet', 'funnel']);
  });
});

describe('relay HTTP contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const candidates = { discover: async () => ladder.endpoints };
    const devices = {
      verifyDevice: (id: string, secret: string) => id === 'device-1' && secret === 'good',
    };
    const tickets = {
      mint: (deviceId: string) => ({ ticket: `rt1.${deviceId}.signed`, expiresAt: 1_700_000_060_000 }),
      verify: (ticket: string, scope: string) =>
        ticket === 'rt1.valid.signed' && scope === 'relay:endpoints'
          ? { deviceId: 'device-1' }
          : null,
    };
    const health = { probeAll: async () => healthResult };
    const moduleRef = await Test.createTestingModule({
      controllers: [RelayController],
      providers: [
        { provide: CandidateUrlsService, useValue: candidates },
        { provide: DevicesService, useValue: devices },
        { provide: ConnectionTicketService, useValue: tickets },
        { provide: RelayHealthService, useValue: health },
      ],
    }).compile();
    moduleRef.get(RelayController).setClock(() => 1_700_000_000_000);
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves GET /api/relay/endpoints with auth and the exact ladder shape', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/relay/endpoints')
      .set('Authorization', 'Bearer nd1.device-1.good');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ...ladder.endpoints, updatedAt: 1_700_000_000_000 });
  });

  it('returns 401 without a device bearer or ticket', async () => {
    const response = await request(app.getHttpServer()).get('/api/relay/endpoints');
    expect(response.status).toBe(401);
  });

  it('serves POST /api/relay/ticket without changing the pairing claim response', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/relay/ticket')
      .set('Authorization', 'Bearer nd1.device-1.good');
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      ticket: 'rt1.device-1.signed',
      expiresAt: 1_700_000_060_000,
    });
  });
});
