import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../src/db/database.service';
import { DevicesRepository } from '../../../src/devices/devices.repository';
import { DevicesService } from '../../../src/devices/devices.service';
import { PushRepository } from '../../../src/push/push.repository';
import {
  PushService,
  type ExpoSdkClient,
  type PushMessage,
} from '../../../src/push/push.service';
import { EventsRepository } from '../../../src/sessions/persistence/events.repository';

let dataDir: string;
let db: DatabaseService;
let devices: DevicesService;
let tokens: PushRepository;
let push: PushService;
let sent: PushMessage[][];

function seedSession(id = 'session-1', title = 'Release the app'): void {
  db.db
    .prepare(
      `INSERT INTO sessions (id, title, prompt, verify_owner, created_at, updated_at)
       VALUES (?, ?, ?, 'session', ?, ?)`,
    )
    .run(id, title, 'prompt', Date.now(), Date.now());
}

function fakeExpo(overrides: Partial<ExpoSdkClient> = {}): ExpoSdkClient {
  return {
    isExpoPushToken: (token) => /^ExponentPushToken\[[^\]]+\]$/.test(token),
    chunkPushNotifications: (messages) => [messages],
    sendPushNotificationsAsync: async (messages) => {
      sent.push(messages);
      return messages.map((_, index) => ({ status: 'ok', id: `receipt-${index}` }));
    },
    chunkPushNotificationReceiptIds: (ids) => [ids],
    getPushNotificationReceiptsAsync: async () => ({}),
    ...overrides,
  };
}

async function flushPush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nuncio-action-push-'));
  process.env.NUNCIO_DATA_DIR = dataDir;
  db = new DatabaseService();
  devices = new DevicesService(new DevicesRepository(db));
  tokens = new PushRepository(db);
  sent = [];
  push = new PushService(tokens, db);
  push.setExpoSdk(fakeExpo());
  push.onModuleInit();
});

afterEach(() => {
  push.onModuleDestroy();
  db.onModuleDestroy();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.NUNCIO_DATA_DIR;
});

describe('actionable session push contracts', () => {
  it('sends the exact frozen question payload with at most four numbered options', async () => {
    seedSession();
    const device = devices.create('Phone', 'ios');
    tokens.registerForDevice(device.id, 'ExponentPushToken[q]', 'ios');

    await push.onSessionEvent('session-1', {
      seq: 1,
      createdAt: 1,
      type: 'user_input_requested',
      payload: {
        requestId: 'question-7',
        title: 'Choose a release lane',
        questions: [
          {
            id: 'lane',
            prompt: 'Which lane?',
            options: ['Dev', 'Beta', 'Stable', 'Canary', 'Nightly'].map((label) => ({
              id: label.toLowerCase(),
              label,
            })),
          },
          { id: 'later', prompt: 'Ignored', options: [{ id: 'x', label: 'X' }] },
        ],
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0][0]?.categoryId).toBe('QUESTION');
    expect(sent[0][0]?.data).toEqual({
      type: 'question',
      sessionId: 'session-1',
      requestId: 'question-7',
      title: 'Choose a release lane',
      questionCount: 2,
      options: [
        { n: 1, label: 'Dev' },
        { n: 2, label: 'Beta' },
        { n: 3, label: 'Stable' },
        { n: 4, label: 'Canary' },
      ],
      categoryId: 'QUESTION',
      deepLink: 'nuncio://session/session-1',
    });
  });

  it('sends the exact frozen approval payload', async () => {
    seedSession('session-2', 'Deploy production');
    const device = devices.create('Phone', 'ios');
    tokens.registerForDevice(device.id, 'ExponentPushToken[a]', 'ios');

    await push.onSessionEvent('session-2', {
      seq: 1,
      createdAt: 1,
      type: 'provider_request',
      payload: { requestId: 'approval-3', provider: 'codex', method: 'command', status: 'pending' },
    });

    expect(sent[0][0]?.categoryId).toBe('APPROVAL');
    expect(sent[0][0]?.data).toEqual({
      type: 'approval',
      sessionId: 'session-2',
      requestId: 'approval-3',
      title: 'Deploy production',
      categoryId: 'APPROVAL',
      deepLink: 'nuncio://session/session-2',
    });
  });

  it('gates delivery using each device token notification preference', async () => {
    seedSession();
    const enabled = devices.create('Enabled', 'ios');
    const disabled = devices.create('Disabled', 'ios');
    tokens.registerForDevice(enabled.id, 'ExponentPushToken[on]', 'ios', true);
    tokens.registerForDevice(disabled.id, 'ExponentPushToken[off]', 'ios', false);

    await push.onSessionEvent('session-1', {
      seq: 1,
      createdAt: 1,
      type: 'provider_request',
      payload: { requestId: 'approval-1' },
    });

    expect(sent.flat().map((message) => message.to)).toEqual(['ExponentPushToken[on]']);
  });

  it('does not throw into event persistence when the Expo SDK throws synchronously', () => {
    seedSession();
    const device = devices.create('Phone', 'ios');
    tokens.registerForDevice(device.id, 'ExponentPushToken[x]', 'ios');
    push.setExpoSdk(
      fakeExpo({
        sendPushNotificationsAsync: (() => {
          throw new Error('sync Expo failure');
        }) as ExpoSdkClient['sendPushNotificationsAsync'],
      }),
    );
    const events = new EventsRepository(db);

    expect(() =>
      events.append('session-1', 'provider_request', { requestId: 'approval-sync' }),
    ).not.toThrow();
    expect(events.list('session-1').map((event) => event.type)).toEqual(['provider_request']);
  });

  it('does not reject into event persistence when the Expo SDK rejects', async () => {
    seedSession();
    const device = devices.create('Phone', 'ios');
    tokens.registerForDevice(device.id, 'ExponentPushToken[x]', 'ios');
    push.setExpoSdk(
      fakeExpo({
        sendPushNotificationsAsync: async () => {
          throw new Error('async Expo failure');
        },
      }),
    );
    const events = new EventsRepository(db);

    expect(() =>
      events.append('session-1', 'user_input_requested', {
        requestId: 'question-async',
        questions: [{ id: 'q', prompt: 'Continue?', options: [{ id: 'yes', label: 'Yes' }] }],
      }),
    ).not.toThrow();
    await flushPush();
    expect(events.list('session-1').map((event) => event.type)).toEqual(['user_input_requested']);
  });
});
