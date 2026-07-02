import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { apiFetch } from '@nuncio/core/http';
import { applyConnection } from '../lib/api-setup';
import {
  clearConnection,
  loadConnection,
  type ConnectionConfig,
} from '../lib/connection-store';
import { secureStore } from '../lib/secure-store-adapter';

type Health = 'checking' | 'ok' | 'unreachable';

export default function Home() {
  const router = useRouter();
  const [connection, setConnection] = useState<ConnectionConfig | null | undefined>(undefined);
  const [health, setHealth] = useState<Health>('checking');

  useEffect(() => {
    loadConnection(secureStore).then((loaded) => {
      if (loaded) applyConnection(loaded);
      setConnection(loaded);
    });
  }, []);

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    apiFetch('/api/health')
      .then((res) => {
        if (!cancelled) setHealth(res.ok ? 'ok' : 'unreachable');
      })
      .catch(() => {
        if (!cancelled) setHealth('unreachable');
      });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  const unpair = useCallback(async () => {
    await clearConnection(secureStore);
    router.replace('/pairing');
  }, [router]);

  if (connection === undefined) return null;
  if (connection === null) return <Redirect href="/pairing" />;

  return (
    <View className="flex-1 items-center justify-center bg-background px-8">
      <Text className="text-2xl font-semibold text-foreground">Nuncio</Text>
      <Text className="mt-2 text-center text-muted-foreground">{connection.serverUrl}</Text>
      <Text className="mt-4 text-sm text-muted-foreground">
        {health === 'checking' && 'Checking server…'}
        {health === 'ok' && 'Connected — sessions arrive in the next milestone.'}
        {health === 'unreachable' && 'Server unreachable. Check Tailscale and the URL.'}
      </Text>
      <Pressable onPress={unpair} className="mt-8 rounded-lg border border-border px-4 py-2">
        <Text className="text-foreground">Change server</Text>
      </Pressable>
    </View>
  );
}
