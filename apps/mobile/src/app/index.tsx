import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import {
  fetchArchivedSessions,
  fetchSessions,
  type Session,
} from '@nuncio/core/api';
import { applyConnection } from '../lib/api-setup';
import {
  clearConnection,
  loadConnection,
  type ConnectionConfig,
} from '../lib/connection-store';
import { secureStore } from '../lib/secure-store-adapter';
import { registerForPush } from '../lib/push-registration';
import { SessionRow } from '../components/session-row';

type Tab = 'active' | 'archived';

export default function SessionList() {
  const router = useRouter();
  const [connection, setConnection] = useState<ConnectionConfig | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('active');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadConnection(secureStore).then((loaded) => {
      if (loaded) {
        applyConnection(loaded);
        void registerForPush();
      }
      setConnection(loaded);
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!connection) return;
    setRefreshing(true);
    try {
      const list = tab === 'active' ? await fetchSessions() : await fetchArchivedSessions();
      setSessions(tab === 'active' ? list.filter((s) => s.status !== 'ARCHIVED') : list);
      setError(null);
    } catch {
      setError('Could not load sessions. Check the connection.');
    } finally {
      setRefreshing(false);
    }
  }, [connection, tab]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const unpair = useCallback(async () => {
    await clearConnection(secureStore);
    router.replace('/pairing');
  }, [router]);

  if (connection === undefined) return null;
  if (connection === null) return <Redirect href="/pairing" />;

  return (
    <View className="flex-1 bg-background pt-16">
      <View className="flex-row items-center justify-between px-4 pb-3">
        <View>
          <Text className="text-2xl font-semibold text-foreground">Sessions</Text>
          <Pressable onPress={unpair}>
            <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
              {connection.serverUrl} · change
            </Text>
          </Pressable>
        </View>
        <Pressable
          onPress={() => router.push('/new')}
          className="h-10 w-10 items-center justify-center rounded-full bg-primary"
        >
          <Text className="text-xl text-primary-foreground">＋</Text>
        </Pressable>
      </View>

      <View className="flex-row gap-2 px-4 pb-2">
        {(['active', 'archived'] as const).map((t) => (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 ${tab === t ? 'bg-secondary' : ''}`}
          >
            <Text className={tab === t ? 'text-foreground' : 'text-muted-foreground'}>
              {t === 'active' ? 'Active' : 'Archived'}
            </Text>
          </Pressable>
        ))}
      </View>

      {error ? <Text className="px-4 py-2 text-sm text-destructive">{error}</Text> : null}

      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => (
          <SessionRow session={item} onPress={() => router.push(`/session/${item.id}`)} />
        )}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor="#9ca3af" />}
        ListEmptyComponent={
          refreshing ? null : (
            <Text className="px-4 py-8 text-center text-muted-foreground">
              {tab === 'active' ? 'No sessions yet — create one with ＋' : 'Nothing archived.'}
            </Text>
          )
        }
      />
    </View>
  );
}
