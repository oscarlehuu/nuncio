import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { fetchArchivedSessions, fetchSessions, type Session } from '@nuncio/core/api';
import { fetchCrewRuns } from '@nuncio/core/crew-api';
import { applyConnection, updateActiveSecret } from '../lib/api-setup';
import { clearConnection, loadConnection, type ConnectionConfig } from '../lib/connection-store';
import { crewTaskPath } from '../lib/crew-navigation';
import {
  buildCrewRunRows,
  type CrewRunRowModel,
} from '../lib/crew-run-list';
import { secureStore } from '../lib/secure-store-adapter';
import { registerForPush } from '../lib/push-registration';
import { rotateDeviceSecret } from '../lib/rotate-secret';
import { CrewRunRow } from '../components/crew-run-row';
import { SessionRow } from '../components/session-row';

type Tab = 'active' | 'archived';
type HomeItem =
  | { kind: 'session'; key: string; updatedAt: number; session: Session }
  | { kind: 'crew'; key: string; updatedAt: number; row: CrewRunRowModel };

export default function SessionList() {
  const router = useRouter();
  const [connection, setConnection] = useState<ConnectionConfig | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('active');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [crewRows, setCrewRows] = useState<CrewRunRowModel[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadConnection(secureStore).then(async (loaded) => {
      if (loaded) {
        applyConnection(loaded);
        void registerForPush();
        const outcome = await rotateDeviceSecret({
          config: loaded,
          store: secureStore,
          fetchImpl: (input, init) => fetch(input, init),
          applySecret: updateActiveSecret,
        });
        if (outcome === 'revoked') {
          await clearConnection(secureStore);
          router.replace('/pairing');
          return;
        }
      }
      setConnection(loaded);
    });
  }, [router]);

  const refresh = useCallback(async () => {
    if (!connection) return;
    setRefreshing(true);
    try {
      if (tab === 'archived') {
        setSessions(await fetchArchivedSessions());
        setCrewRows([]);
      } else {
        const [sessionList, runs] = await Promise.all([
          fetchSessions(), fetchCrewRuns({ limit: 50 }),
        ]);
        setSessions(sessionList.filter((session) => session.status !== 'ARCHIVED'));
        setCrewRows(buildCrewRunRows(runs));
      }
      setError(null);
    } catch {
      setError('Could not load work. Check the connection.');
    } finally {
      setRefreshing(false);
    }
  }, [connection, tab]);

  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const items = useMemo<HomeItem[]>(() => {
    const sessionItems: HomeItem[] = sessions.map((session) => ({
      kind: 'session', key: `session:${session.id}`, updatedAt: session.updatedAt, session,
    }));
    const crewItems: HomeItem[] = crewRows.map((row) => ({
      kind: 'crew', key: row.key, updatedAt: row.updatedAt, row,
    }));
    return [...sessionItems, ...crewItems].sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
  }, [crewRows, sessions]);

  const unpair = useCallback(async () => {
    await clearConnection(secureStore);
    router.replace('/pairing');
  }, [router]);

  if (connection === undefined) return null;
  if (connection === null) return <Redirect href="/pairing" />;

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-row items-start justify-between px-4 pb-2">
        <View className="min-w-0 flex-1">
          <Text className="text-2xl font-semibold text-foreground">Work</Text>
          <Pressable onPress={unpair} className="min-h-11 justify-center">
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>{connection.serverUrl} · change</Text>
          </Pressable>
        </View>
        <Pressable
          accessibilityLabel="New task"
          onPress={() => router.push('/new')}
          className="h-11 w-11 items-center justify-center rounded-full bg-primary"
        >
          <Text className="text-xl text-primary-foreground">＋</Text>
        </Pressable>
      </View>

      <View className="flex-row gap-2 px-4 pb-2">
        {(['active', 'archived'] as const).map((item) => (
          <Pressable
            key={item}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === item }}
            onPress={() => setTab(item)}
            className={`min-h-11 justify-center rounded-full px-4 ${tab === item ? 'bg-secondary' : ''}`}
          >
            <Text className={tab === item ? 'text-foreground' : 'text-muted-foreground'}>
              {item === 'active' ? 'Active' : 'Archived'}
            </Text>
          </Pressable>
        ))}
      </View>

      {error ? <Text className="px-4 py-2 text-sm text-destructive">{error}</Text> : null}
      <FlatList
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => item.kind === 'session'
          ? <SessionRow session={item.session} onPress={() => router.push(`/session/${item.session.id}`)} />
          : <CrewRunRow row={item.row} onPress={() => router.push(crewTaskPath(item.row.taskId))} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor="#9ca3af" />}
        ListEmptyComponent={refreshing ? null : (
          <Text className="px-4 py-8 text-center text-muted-foreground">
            {tab === 'active' ? 'No sessions or active Crew runs yet — create one with ＋' : 'Nothing archived.'}
          </Text>
        )}
      />
    </SafeAreaView>
  );
}
