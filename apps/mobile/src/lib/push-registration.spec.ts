import { describe, expect, it, vi } from 'vitest';
import type { NotificationResponse } from 'expo-notifications';

vi.mock('expo-device', () => ({ isDevice: false, deviceName: null }));
vi.mock('expo-notifications', () => ({}));
vi.mock('expo-constants', () => ({ default: { expoConfig: null, easConfig: null } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@nuncio/core/http', () => ({ apiFetch: vi.fn() }));
vi.mock('./api-setup', () => ({ activeConnection: vi.fn(() => null) }));

import {
  buildPushTokenBody,
  notificationTargetFromNotification,
  pathFromSessionDeepLink,
  pushTokenPath,
  registerForPush,
  sessionPathFromNotification,
} from './push-registration';

function response(data: Record<string, unknown>): NotificationResponse {
  return { notification: { request: { content: { data } } } } as unknown as NotificationResponse;
}

describe('pushTokenPath', () => {
  it('binds the token to the paired device record', () => {
    expect(pushTokenPath('dev-1')).toBe('/api/devices/dev-1/push-token');
  });

  it('url-encodes an id with reserved characters', () => {
    expect(pushTokenPath('a/b?c')).toBe('/api/devices/a%2Fb%3Fc/push-token');
  });
});

describe('buildPushTokenBody', () => {
  it('emits exactly the frozen { token, platform } shape', () => {
    expect(buildPushTokenBody('ExponentPushToken[abc]', 'ios')).toEqual({
      token: 'ExponentPushToken[abc]',
      platform: 'ios',
    });
  });
});

describe('registerForPush', () => {
  it('reports unsupported off a physical device rather than throwing', async () => {
    await expect(registerForPush()).resolves.toBe('unsupported');
  });
});

describe('pathFromSessionDeepLink', () => {
  it('maps a nuncio session deep link to its route', () => {
    expect(pathFromSessionDeepLink('nuncio://session/abc123')).toBe('/session/abc123');
  });

  it('round-trips an encoded id back through the router path', () => {
    expect(pathFromSessionDeepLink('nuncio://session/a%20b')).toBe('/session/a%20b');
  });

  it('rejects other schemes, other hosts, and non-strings', () => {
    expect(pathFromSessionDeepLink('nuncio://crew/task-1')).toBeNull();
    expect(pathFromSessionDeepLink('https://nuncio/session/abc')).toBeNull();
    expect(pathFromSessionDeepLink('nuncio://session/')).toBeNull();
    expect(pathFromSessionDeepLink(undefined)).toBeNull();
    expect(pathFromSessionDeepLink(42)).toBeNull();
  });
});

describe('sessionPathFromNotification', () => {
  it('reads the route from the payload deepLink', () => {
    expect(sessionPathFromNotification(response({ deepLink: 'nuncio://session/s-9' }))).toBe(
      '/session/s-9',
    );
  });

  it('is null when the payload has no session deep link', () => {
    expect(sessionPathFromNotification(response({ crewTaskId: 'task-1' }))).toBeNull();
  });
});

describe('notificationTargetFromNotification', () => {
  it('routes a Crew notification to the stable CrewTask', () => {
    expect(notificationTargetFromNotification(response({ crewTaskId: 'task-1', crewRunId: 'run-2' }))).toEqual({
      kind: 'crew',
      taskId: 'task-1',
      runId: 'run-2',
    });
  });

  it('prefers Crew routing when a backwards-compatible session id is also present', () => {
    expect(notificationTargetFromNotification(response({ crewTaskId: 'task-1', sessionId: 'session-1' }))).toEqual({
      kind: 'crew',
      taskId: 'task-1',
      runId: null,
    });
  });

  it('preserves existing session routing and rejects malformed ids', () => {
    expect(notificationTargetFromNotification(response({ sessionId: 'session-1' }))).toEqual({
      kind: 'session',
      sessionId: 'session-1',
    });
    expect(notificationTargetFromNotification(response({ crewTaskId: 42, sessionId: null }))).toBeNull();
  });
});
