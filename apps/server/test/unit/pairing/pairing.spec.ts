import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthGuard } from '../../../src/auth/auth.guard';
import type { AuthTokenService } from '../../../src/auth/auth-token.service';
import { TailscaleService } from '../../../src/tailscale/tailscale.service';
import { DatabaseModule } from '../../../src/db/database.module';
import { DevicesModule } from '../../../src/devices/devices.module';
import { DevicesService } from '../../../src/devices/devices.service';
import { PairingModule } from '../../../src/pairing/pairing.module';

// Loopback (supertest's default) always passes the guard, which is exactly what
// exercising the public `claim` path and the guarded `start` path needs. The
// device-bearer auth branch is covered at guard/service level elsewhere.
const passthroughTokens = { isValidToken: () => false } as unknown as AuthTokenService;
const noTrust = { isTrustedRemote: async () => false } as unknown as TailscaleService;

// pairing/start builds candidate URLs, which consult TailscaleService. Booting the
// real service would run `tailscale serve/funnel` for real on a Tailscale-enabled
// host — a unit test must never mutate machine state. Override with an inert fake
// and assert serve/funnel are never touched.
const tailscaleCalls: string[] = [];
const inertTailscale = {
  status: async () => ({
    installed: false,
    running: false,
    autoTrust: false,
    tailnet: null,
    self: null,
    peers: [],
  }),
  enableServe: async () => {
    tailscaleCalls.push('serve');
    return false;
  },
  enableFunnel: async () => {
    tailscaleCalls.push('funnel');
    return { ok: false, reason: 'error' as const };
  },
  isTrustedRemote: async () => false,
} as unknown as TailscaleService;

let app: INestApplication;
let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'nuncio-pairing-'));
  process.env.NUNCIO_DATA_DIR = dataDir;
  tailscaleCalls.length = 0;

  const moduleRef = await Test.createTestingModule({
    imports: [DatabaseModule, DevicesModule, PairingModule],
    providers: [
      Reflector,
      {
        provide: APP_GUARD,
        useFactory: (devices: DevicesService) =>
          new AuthGuard(new Reflector(), passthroughTokens, noTrust, devices),
        inject: [DevicesService],
      },
    ],
  })
    .overrideProvider(TailscaleService)
    .useValue(inertTailscale)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.NUNCIO_DATA_DIR;
});

async function startCode(): Promise<string> {
  const res = await request(app.getHttpServer()).post('/api/pairing/start');
  expect(res.status).toBe(201);
  expect(typeof res.body.code).toBe('string');
  expect(Array.isArray(res.body.urls)).toBe(true);
  expect(Array.isArray(res.body.hints)).toBe(true);
  expect(res.body.endpoints).toEqual(expect.objectContaining({ lan: expect.any(Array) }));
  return res.body.code;
}

describe('pairing HTTP lifecycle', () => {
  it('keeps the legacy start fields in their original order and adds only endpoints', async () => {
    const res = await request(app.getHttpServer()).post('/api/pairing/start');
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['code', 'expiresAt', 'urls', 'hints', 'endpoints']);
    expect(JSON.stringify({
      code: res.body.code,
      expiresAt: res.body.expiresAt,
      urls: res.body.urls,
      hints: res.body.hints,
    })).toBe(JSON.stringify(Object.fromEntries(Object.entries(res.body).slice(0, 4))));
  });

  it('start never runs tailscale serve/funnel against the host in a unit test', async () => {
    await startCode();
    // The inert fake reports tailscale offline, so the builder must short-circuit
    // before ever touching serve/funnel. A regression here would mutate real machine
    // state on a Tailscale-enabled dev/CI box.
    expect(tailscaleCalls).toEqual([]);
  });

  it('start → claim returns a deviceId + secret and a server name', async () => {
    const code = await startCode();
    const res = await request(app.getHttpServer())
      .post('/api/pairing/claim')
      .send({ code, deviceName: 'My Phone', platform: 'ios' });

    expect(res.status).toBe(201);
    expect(typeof res.body.deviceId).toBe('string');
    expect(typeof res.body.deviceSecret).toBe('string');
    expect(typeof res.body.serverName).toBe('string');
    expect(Object.keys(res.body)).toEqual(['deviceId', 'deviceSecret', 'serverName']);

    // The minted credential must verify against the device store.
    const devices = app.get(DevicesService);
    expect(devices.verifyDevice(res.body.deviceId, res.body.deviceSecret)).toBe(true);
  });

  it('an old-format QR fixture with no endpoints field still pairs unchanged', async () => {
    const started = await request(app.getHttpServer()).post('/api/pairing/start');
    const oldQrFixture = JSON.parse(JSON.stringify({
      v: 1,
      code: started.body.code,
      urls: started.body.urls,
    })) as { v: number; code: string; urls: string[]; endpoints?: unknown };

    expect(oldQrFixture).toEqual({ v: 1, code: started.body.code, urls: started.body.urls });
    expect(oldQrFixture.endpoints).toBeUndefined();

    const claim = await request(app.getHttpServer())
      .post('/api/pairing/claim')
      .send({ code: oldQrFixture.code, platform: 'ios' });
    expect(claim.status).toBe(201);
    expect(Object.keys(claim.body)).toEqual(['deviceId', 'deviceSecret', 'serverName']);
    expect(JSON.stringify(claim.body)).toBe(JSON.stringify({
      deviceId: claim.body.deviceId,
      deviceSecret: claim.body.deviceSecret,
      serverName: claim.body.serverName,
    }));
  });

  it('a claimed code cannot be claimed again', async () => {
    const code = await startCode();
    await request(app.getHttpServer()).post('/api/pairing/claim').send({ code, deviceName: 'A' });
    const second = await request(app.getHttpServer())
      .post('/api/pairing/claim')
      .send({ code, deviceName: 'B' });
    expect(second.status).toBe(401);
  });

  it('does not consume the code when device persistence fails', async () => {
    const code = await startCode();
    const devices = app.get(DevicesService);
    const createSpy = spyOn(devices, 'create')
      .mockImplementationOnce(() => { throw new Error('device store unavailable'); });

    try {
      const failed = await request(app.getHttpServer())
        .post('/api/pairing/claim')
        .send({ code, deviceName: 'Retry Phone', platform: 'ios' });
      expect(failed.status).toBe(500);

      const recovered = await request(app.getHttpServer())
        .post('/api/pairing/claim')
        .send({ code, deviceName: 'Retry Phone', platform: 'ios' });
      expect(recovered.status).toBe(201);
      expect(devices.verifyDevice(recovered.body.deviceId, recovered.body.deviceSecret)).toBe(true);

      const consumed = await request(app.getHttpServer())
        .post('/api/pairing/claim')
        .send({ code, deviceName: 'Too Late' });
      expect(consumed.status).toBe(401);
      expect(devices.list().filter((device) => device.name === 'Retry Phone')).toHaveLength(1);
    } finally {
      createSpy.mockRestore();
    }
  });

  it('allows only one of two concurrent claims to create a device', async () => {
    const code = await startCode();
    const before = app.get(DevicesService).list().length;
    const [first, second] = await Promise.all([
      request(app.getHttpServer()).post('/api/pairing/claim').send({ code, deviceName: 'Concurrent A' }),
      request(app.getHttpServer()).post('/api/pairing/claim').send({ code, deviceName: 'Concurrent B' }),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 401]);
    expect(app.get(DevicesService).list()).toHaveLength(before + 1);
  });

  it('a wrong code is rejected', async () => {
    await startCode();
    const res = await request(app.getHttpServer())
      .post('/api/pairing/claim')
      .send({ code: 'not-a-real-code', deviceName: 'A' });
    expect(res.status).toBe(401);
  });

  it('a new start invalidates the previous code', async () => {
    const first = await startCode();
    await startCode(); // replaces the active code
    const res = await request(app.getHttpServer())
      .post('/api/pairing/claim')
      .send({ code: first, deviceName: 'A' });
    expect(res.status).toBe(401);
  });

  it('rotate rejects a caller with no device bearer (loopback alone is not enough)', async () => {
    const res = await request(app.getHttpServer()).post('/api/devices/rotate');
    expect(res.status).toBe(401);

    const globalToken = await request(app.getHttpServer())
      .post('/api/devices/rotate')
      .set('Authorization', 'Bearer some-global-token');
    expect(globalToken.status).toBe(401);
  });

  it('rotate with a valid device bearer returns a fresh secret and invalidates the old one', async () => {
    const code = await startCode();
    const claim = await request(app.getHttpServer())
      .post('/api/pairing/claim')
      .send({ code, deviceName: 'Phone' });
    const { deviceId, deviceSecret } = claim.body;

    const res = await request(app.getHttpServer())
      .post('/api/devices/rotate')
      .set('Authorization', `Bearer nd1.${deviceId}.${deviceSecret}`);
    expect(res.status).toBe(201);
    expect(res.body.deviceId).toBe(deviceId);
    expect(typeof res.body.deviceSecret).toBe('string');
    expect(res.body.deviceSecret).not.toBe(deviceSecret);

    // New secret verifies; after first use of it, the old secret's grace is gone.
    const devices = app.get(DevicesService);
    expect(devices.verifyDevice(deviceId, res.body.deviceSecret)).toBe(true);
    expect(devices.verifyDevice(deviceId, deviceSecret)).toBe(false);
  });

  it('rotate rejects a revoked device bearer', async () => {
    const code = await startCode();
    const claim = await request(app.getHttpServer())
      .post('/api/pairing/claim')
      .send({ code, deviceName: 'Phone' });
    const { deviceId, deviceSecret } = claim.body;
    app.get(DevicesService).revoke(deviceId);

    const res = await request(app.getHttpServer())
      .post('/api/devices/rotate')
      .set('Authorization', `Bearer nd1.${deviceId}.${deviceSecret}`);
    expect(res.status).toBe(401);
  });

  it('GET /api/devices lists paired devices and DELETE revokes one', async () => {
    const code = await startCode();
    const claim = await request(app.getHttpServer())
      .post('/api/pairing/claim')
      .send({ code, deviceName: 'Phone', platform: 'ios' });
    const { deviceId } = claim.body;

    const list = await request(app.getHttpServer()).get('/api/devices');
    expect(list.status).toBe(200);
    const entry = list.body.find((d: { id: string }) => d.id === deviceId);
    expect(entry).toBeDefined();
    expect(entry.name).toBe('Phone');
    expect(entry.revoked).toBe(false);
    expect(entry.secret_hash).toBeUndefined();
    expect(entry.secretHash).toBeUndefined();

    const del = await request(app.getHttpServer()).delete(`/api/devices/${deviceId}`);
    expect(del.status).toBe(200);
    const after = await request(app.getHttpServer()).get('/api/devices');
    expect(after.body.find((d: { id: string }) => d.id === deviceId)?.revoked).toBe(true);
  });

  it('rate-limits claim to 10 attempts per minute (11th is 429)', async () => {
    // Ten wrong-code attempts stay under the limit (each 401); the eleventh trips 429.
    for (let i = 0; i < 10; i += 1) {
      const res = await request(app.getHttpServer())
        .post('/api/pairing/claim')
        .send({ code: `bad-${i}`, deviceName: 'A' });
      expect(res.status).toBe(401);
    }
    const eleventh = await request(app.getHttpServer())
      .post('/api/pairing/claim')
      .send({ code: 'bad-11', deviceName: 'A' });
    expect(eleventh.status).toBe(429);
  });
});
