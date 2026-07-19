import '../global.css';
import { useEffect, useRef } from 'react';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { PortalHost } from '@rn-primitives/portal';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { notificationPath } from '../lib/crew-navigation';
import {
  notificationTargetFromNotification,
  sessionPathFromNotification,
} from '../lib/push-registration';
import { registerNotificationCategories } from '../lib/notification-categories';

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
  // Notifications reach us twice on a cold start (the launch response via
  // getLast AND the live listener); route each request identifier once.
  const routed = useRef<Set<string>>(new Set());

  useEffect(() => {
    // The cold-start replay is an async resolve with no unsubscribe of its own;
    // this flag stops it navigating after the effect is torn down.
    let cancelled = false;

    // Action buttons must be registered before any push is delivered.
    void registerNotificationCategories();

    // A tap on the body OR any action button (Approve / Deny / Option N) opens
    // the session for now — per-action answering is a later lane. Prefer the
    // payload's explicit deepLink, then fall back to id routing (Crew pushes
    // carry a crewTaskId instead of a session deep link).
    const route = (response: Notifications.NotificationResponse | null): void => {
      if (!response) return;
      const key = response.notification.request.identifier;
      if (routed.current.has(key)) return;
      routed.current.add(key);
      const deepLinkPath = sessionPathFromNotification(response);
      if (deepLinkPath) {
        router.push(deepLinkPath);
        return;
      }
      const target = notificationTargetFromNotification(response);
      if (target) router.push(notificationPath(target));
    };

    // Cold start: the notification that launched the app is not delivered to the
    // live listener, so replay (and clear) the last response once on mount.
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (cancelled) return undefined;
        route(response);
        return response ? Notifications.clearLastNotificationResponseAsync() : undefined;
      })
      .catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener(route);
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [router]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <BottomSheetModalProvider>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: '#121314' },
          }}
        />
        <PortalHost />
        <StatusBar style="light" />
      </BottomSheetModalProvider>
    </GestureHandlerRootView>
  );
}
