import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { apiFetch } from '@nuncio/core/http';

/**
 * Best-effort push registration: needs a physical device, granted permission,
 * and an EAS projectId (dev/production build — Expo Go cannot receive remote
 * pushes since SDK 53). Every failure is silent by design; the app works
 * fully without push.
 */
export async function registerForPush(): Promise<boolean> {
  try {
    if (!Device.isDevice) return false;
    const projectId: string | undefined =
      Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) return false;

    const existing = await Notifications.getPermissionsAsync();
    const status = existing.granted
      ? existing
      : await Notifications.requestPermissionsAsync();
    if (!status.granted) return false;

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    const res = await apiFetch('/api/push/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        platform: Platform.OS,
        deviceName: Device.deviceName ?? undefined,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export type NotificationTarget =
  | { kind: 'crew'; taskId: string; runId: string | null }
  | { kind: 'session'; sessionId: string };

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Resolve notification navigation without letting a member-session id hide its CrewTask. */
export function notificationTargetFromNotification(
  response: Notifications.NotificationResponse,
): NotificationTarget | null {
  const data = response.notification.request.content.data as
    | { crewTaskId?: unknown; crewRunId?: unknown; sessionId?: unknown }
    | undefined;
  const taskId = nonEmptyString(data?.crewTaskId);
  if (taskId) {
    return { kind: 'crew', taskId, runId: nonEmptyString(data?.crewRunId) };
  }
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
