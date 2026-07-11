import '../global.css';
import { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { notificationPath } from '../lib/crew-navigation';
import { notificationTargetFromNotification } from '../lib/push-registration';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export default function RootLayout() {
  const router = useRouter();

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const target = notificationTargetFromNotification(response);
      if (target) router.push(notificationPath(target));
    });
    return () => sub.remove();
  }, [router]);

  return (
    <>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: '#0d0f12' },
        }}
      />
      <StatusBar style="light" />
    </>
  );
}
