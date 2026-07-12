import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { BadRequestException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthRequestLike } from '../../../src/auth/auth-request';
import { DatabaseService } from '../../../src/db/database.service';
import { DevicesController } from '../../../src/devices/devices.controller';
import { DevicesRepository } from '../../../src/devices/devices.repository';
import { DevicesService } from '../../../src/devices/devices.service';
import { PushRepository } from '../../../src/push/push.repository';
import { PushService, type ExpoSdkClient } from '../../../src/push/push.service';

let dataDir: string;
let db: DatabaseService;
let devices: DevicesService;
let tokens: PushRepository;
let push: PushService;
let controller: DevicesController;

function requestFor(deviceId: string, secret: string): AuthRequestLike {
  return { headers: { authorization: `Bearer nd1.${deviceId}.${secret}` } };
}

function fakeExpo(): ExpoSdkClient {
  return {
    isExpoPushToken: (token) => /^ExponentPushToken\[[^\]]+\]$/.test(token),
    chunkPushNotifications: (messages) => [messages],
    sendPushNotificationsAsync: async () => [],
    chunkPushNotificationReceiptIds: (ids) => [ids],
    getPushNotificationReceiptsAsync: async () => ({}),
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nuncio-device-push-'));
  process.env.NUNCIO_DATA_DIR = dataDir;
  db = new DatabaseService();
  devices = new DevicesService(new DevicesRepository(db));
  tokens = new PushRepository(db);
  push = new PushService(tokens, db);
  push.setExpoSdk(fakeExpo());
  controller = new DevicesController(devices, push);
});

afterEach(() => {
  db.onModuleDestroy();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.NUNCIO_DATA_DIR;
});

describe('POST /api/devices/:deviceId/push-token', () => {
  it('registers a valid Expo token for the authenticated paired device', async () => {
    const device = devices.create('Phone', 'ios');

    await expect(
      controller.registerPushToken(
        device.id,
        { token: 'ExponentPushToken[valid]', platform: 'ios' },
        requestFor(device.id, device.secret),
      ),
    ).resolves.toEqual({ ok: true });

    expect(tokens.list()).toEqual([
      {
        token: 'ExponentPushToken[valid]',
        platform: 'ios',
        deviceName: null,
        deviceId: device.id,
        notificationsEnabled: true,
      },
    ]);
  });

  it('rejects a token that Expo does not recognize', async () => {
    const device = devices.create('Phone', 'ios');

    await expect(
      controller.registerPushToken(
        device.id,
        { token: 'not-an-expo-token', platform: 'ios' },
        requestFor(device.id, device.secret),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tokens.list()).toHaveLength(0);
  });

  it('keeps a disabled device preference when its Expo token rotates', () => {
    const device = devices.create('Phone', 'ios');
    tokens.registerForDevice(device.id, 'ExponentPushToken[old]', 'ios', false);

    tokens.registerForDevice(device.id, 'ExponentPushToken[new]', 'ios');

    expect(tokens.list()).toMatchObject([
      {
        token: 'ExponentPushToken[new]',
        deviceId: device.id,
        notificationsEnabled: false,
      },
    ]);
  });
});
