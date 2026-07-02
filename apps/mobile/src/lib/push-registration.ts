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

/** sessionId carried in the push payload, for tap-through navigation. */
export function sessionIdFromNotification(
  response: Notifications.NotificationResponse,
): string | null {
  const data = response.notification.request.content.data as { sessionId?: unknown } | undefined;
  return typeof data?.sessionId === 'string' ? data.sessionId : null;
}
