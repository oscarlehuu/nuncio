export type NotificationStatus = 'checking' | 'granted' | 'denied' | 'unavailable';

export function connectionStatusLabel(connection: { serverUrl: string } | null): string {
  if (!connection) return 'Not paired';
  try {
    return `Connected to ${new URL(connection.serverUrl).host}`;
  } catch {
    return 'Connected';
  }
}

export function notificationStatusLabel(status: NotificationStatus): string {
  if (status === 'checking') return 'Checking notification access…';
  if (status === 'granted') return 'Notifications enabled';
  if (status === 'denied') return 'Notifications are off';
  return 'Notifications unavailable';
}
