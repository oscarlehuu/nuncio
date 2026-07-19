import { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import {
  Bell,
  ChevronRight,
  ExternalLink,
  Info,
  Link2,
  LogOut,
  Server,
} from 'lucide-react-native';
import { crewProfileSettingsUrl } from '../../lib/crew-composer';
import { applyConnection } from '../../lib/api-setup';
import { clearConnection, loadConnection, type ConnectionConfig } from '../../lib/connection-store';
import { secureStore } from '../../lib/secure-store-adapter';
import {
  connectionStatusLabel,
  notificationStatusLabel,
  type NotificationStatus,
} from '../../lib/settings-ui';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Text } from '../../components/ui/text';

export default function SettingsScreen() {
  const router = useRouter();
  const [connection, setConnection] = useState<ConnectionConfig | null | undefined>(undefined);
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>('checking');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadConnection(secureStore).then((loaded) => {
      if (cancelled) return;
      if (loaded) applyConnection(loaded);
      setConnection(loaded);
    });
    void Notifications.getPermissionsAsync()
      .then((permissions) => {
        if (!cancelled) setNotificationStatus(permissions.granted ? 'granted' : 'denied');
      })
      .catch(() => {
        if (!cancelled) setNotificationStatus('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const disconnect = async () => {
    await clearConnection(secureStore);
    router.replace('/pairing');
  };

  const openCrewSettings = () => {
    if (!connection?.serverUrl) {
      setError('Pair with your Nuncio machine before opening Crew settings.');
      return;
    }
    void Linking.openURL(crewProfileSettingsUrl(connection.serverUrl)).catch(() => {
      setError('Could not open Crew profile settings.');
    });
  };

  if (connection === undefined) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="px-4 pt-4">
          <Text className="text-3xl font-semibold tracking-tight text-foreground">Settings</Text>
          <Text className="mt-2 text-sm text-muted-foreground">Loading your connection…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-5 px-4 pb-8 pt-2"
      >
        <View>
          <Text className="text-3xl font-semibold tracking-tight text-foreground">Settings</Text>
          <Text className="mt-2 text-sm text-muted-foreground">
            Manage this phone’s connection and agent preferences.
          </Text>
        </View>

        <Card className="gap-0 rounded-2xl border-border/70 px-4 py-4 shadow-none">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 flex-row items-center gap-2">
              <Server color="#208AEF" size={17} />
              <Text className="font-semibold text-foreground">Connection</Text>
            </View>
            <Badge variant={connection ? 'default' : 'destructive'}>
              <Text>{connection ? 'Connected' : 'Not paired'}</Text>
            </Badge>
          </View>
          <Text className="mt-3 text-sm text-muted-foreground">
            {connectionStatusLabel(connection)}
          </Text>
          {connection ? (
            <Text className="mt-1 text-xs text-muted-foreground" numberOfLines={1}>
              {connection.serverUrl}
            </Text>
          ) : null}
          <Pressable
            onPress={() => router.replace('/pairing')}
            className="mt-4 min-h-11 flex-row items-center justify-between rounded-xl bg-secondary px-3 active:opacity-70"
          >
            <View className="flex-row items-center gap-2">
              <Link2 color="#eff0f1" size={15} />
              <Text className="font-medium text-foreground">
                {connection ? 'Change connection' : 'Pair with a machine'}
              </Text>
            </View>
            <ChevronRight color="#83868b" size={17} />
          </Pressable>
        </Card>

        <Card className="gap-0 rounded-2xl border-border/70 px-4 py-4 shadow-none">
          <View className="flex-row items-center gap-2">
            <Bell color="#208AEF" size={17} />
            <Text className="font-semibold text-foreground">Notifications</Text>
          </View>
          <Text className="mt-3 text-sm text-muted-foreground">
            {notificationStatusLabel(notificationStatus)}
          </Text>
          <Pressable
            onPress={() => void Linking.openSettings()}
            className="mt-4 min-h-11 flex-row items-center justify-between rounded-xl bg-secondary px-3 active:opacity-70"
          >
            <Text className="font-medium text-foreground">Open system settings</Text>
            <ExternalLink color="#83868b" size={16} />
          </Pressable>
        </Card>

        <Card className="gap-0 rounded-2xl border-border/70 px-4 py-4 shadow-none">
          <View className="flex-row items-center gap-2">
            <Link2 color="#208AEF" size={17} />
            <Text className="font-semibold text-foreground">Crew profiles</Text>
          </View>
          <Text className="mt-3 text-sm leading-5 text-muted-foreground">
            Configure the Foreman, Builder, and Reviewer profiles used by Crew runs.
          </Text>
          <Pressable
            onPress={openCrewSettings}
            className="mt-4 min-h-11 flex-row items-center justify-between rounded-xl bg-secondary px-3 active:opacity-70"
          >
            <Text className="font-medium text-foreground">Open Crew profile setup</Text>
            <ExternalLink color="#83868b" size={16} />
          </Pressable>
        </Card>

        {error ? (
          <Text className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</Text>
        ) : null}

        <Card className="gap-0 rounded-2xl border-border/70 px-4 py-4 shadow-none">
          <View className="flex-row items-center gap-2">
            <Info color="#83868b" size={17} />
            <Text className="font-semibold text-foreground">About Nuncio</Text>
          </View>
          <Text className="mt-3 text-sm text-muted-foreground">Version {Constants.expoConfig?.version ?? '1.0.0'}</Text>
        </Card>

        <Button variant="destructive" size="lg" className="rounded-xl" onPress={() => void disconnect()}>
          <LogOut color="#fff" size={17} />
          <Text>Disconnect this device</Text>
        </Button>
      </ScrollView>
    </SafeAreaView>
  );
}
