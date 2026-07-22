import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { apiFetch } from '@nuncio/core/http';
import { activeConnection } from './api-setup';

/**
 * Outcome of a push registration attempt. The home screen surfaces a Settings
 * hint on `permission-denied`; every other non-success stays silent (the app
 * works fully without push).
 */
export type PushRegistrationResult = 'registered' | 'permission-denied' | 'unsupported' | 'error';

/** REST path that binds an Expo push token to the paired device record. */
export function pushTokenPath(deviceId: string): string {
  return `/api/devices/${encodeURIComponent(deviceId)}/push-token`;
}

/** The frozen request body the server expects at {@link pushTokenPath}. */
export function buildPushTokenBody(
  token: string,
  platform: string,
): { token: string; platform: string } {
  return { token, platform };
}

/**
 * Best-effort push registration. Needs a physical device, an EAS projectId
 * (dev/production build — Expo Go can't receive remote pushes since SDK 53),
 * granted permission, and a QR-paired `deviceId`. The token binds to that
 * device record, so a legacy global-token pairing (no `deviceId`) has nowhere to
 * attach it and reports `unsupported`. Returns a typed outcome so a declined
 * permission can be nudged toward Settings; other failures resolve quietly.
 */
export async function registerForPush(): Promise<PushRegistrationResult> {
  try {
    if (!Device.isDevice) return 'unsupported';
    const projectId: string | undefined =
      Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) return 'unsupported';

    const deviceId = activeConnection()?.deviceId;
    if (!deviceId) return 'unsupported';

    const existing = await Notifications.getPermissionsAsync();
    const status = existing.granted ? existing : await Notifications.requestPermissionsAsync();
    if (!status.granted) return 'permission-denied';

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    const res = await apiFetch(pushTokenPath(deviceId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPushTokenBody(token, Platform.OS)),
    });
    return res.ok ? 'registered' : 'error';
  } catch {
    return 'error';
  }
}

/**
 * The `/session/<id>` route encoded by a `nuncio://session/<id>` deep link, or
 * null for anything else. Parses the string literally rather than through a URL
 * host/path parser, whose custom-scheme behaviour differs across platforms.
 */
export function pathFromSessionDeepLink(deepLink: unknown): `/session/${string}` | null {
  if (typeof deepLink !== 'string') return null;
  const match = /^nuncio:\/\/session\/(.+)$/.exec(deepLink.trim());
  if (!match) return null;
  const id = decodeURIComponent(match[1]).trim();
  return id ? `/session/${encodeURIComponent(id)}` : null;
}

/** Session route carried by a push payload's explicit `deepLink`, else null. */
export function sessionPathFromNotification(
  response: Notifications.NotificationResponse,
): `/session/${string}` | null {
  const data = response.notification.request.content.data as { deepLink?: unknown } | undefined;
  return pathFromSessionDeepLink(data?.deepLink);
}

export type NotificationTarget = { kind: 'session'; sessionId: string };

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Resolve notification navigation from the payload's session id, else null. */
export function notificationTargetFromNotification(
  response: Notifications.NotificationResponse,
): NotificationTarget | null {
  const data = response.notification.request.content.data as
    | { sessionId?: unknown }
    | undefined;
  const sessionId = nonEmptyString(data?.sessionId);
  return sessionId ? { kind: 'session', sessionId } : null;
}

/** sessionId carried in older push payloads, retained for API compatibility. */
export function sessionIdFromNotification(
  response: Notifications.NotificationResponse,
): string | null {
  const target = notificationTargetFromNotification(response);
  return target?.kind === 'session' ? target.sessionId : null;
}
