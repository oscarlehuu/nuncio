import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { ChevronRight, Plus, Server, X } from 'lucide-react-native';
import { fetchArchivedSessions, fetchSessions, type Session } from '@nuncio/core/api';
import { fetchCrewRuns } from '@nuncio/core/crew-api';
import { applyConnection, updateActiveSecret } from '../../lib/api-setup';
import { clearConnection, loadConnection, type ConnectionConfig } from '../../lib/connection-store';
import { crewTaskPath } from '../../lib/crew-navigation';
import {
  buildCrewRunRows,
  type CrewRunRowModel,
} from '../../lib/crew-run-list';
import { secureStore } from '../../lib/secure-store-adapter';
import { registerForPush } from '../../lib/push-registration';
import { rotateDeviceSecret } from '../../lib/rotate-secret';
import { useSessionPlans } from '../../lib/use-session-plans';
import { planStepsLabel } from '../../lib/session-plan-progress';
import { CrewRunRow } from '../../components/crew-run-row';
import { SessionRow } from '../../components/session-row';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import { Text } from '../../components/ui/text';

type Tab = 'active' | 'archived';
type HomeItem =
  | { kind: 'session'; key: string; updatedAt: number; session: Session }
  | { kind: 'crew'; key: string; updatedAt: number; row: CrewRunRowModel };

export default function SessionList() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [connection, setConnection] = useState<ConnectionConfig | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('active');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [crewRows, setCrewRows] = useState<CrewRunRowModel[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushDenied, setPushDenied] = useState(false);

  useEffect(() => {
    // Guards every state/navigation that lands after an await: a revoke routes
    // to /pairing (unmounting this screen), so a later registerForPush() or
    // rotate resolve must not touch a dead component.
    let cancelled = false;
    loadConnection(secureStore).then(async (loaded) => {
      if (loaded) {
        applyConnection(loaded);
        registerForPush().then((result) => {
          if (!cancelled) setPushDenied(result === 'permission-denied');
        });
        const outcome = await rotateDeviceSecret({
          config: loaded,
          store: secureStore,
          fetchImpl: (input, init) => fetch(input, init),
          applySecret: updateActiveSecret,
        });
        if (outcome === 'revoked') {
          // The secret is invalid regardless of mount — clear it either way,
          // but only navigate while still mounted.
          await clearConnection(secureStore);
          if (!cancelled) router.replace('/pairing');
          return;
        }
      }
      if (!cancelled) setConnection(loaded);
    });
    return () => {
      cancelled = true;
    };
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

  const sessionPlans = useSessionPlans(sessions);
  const initialLoading = refreshing && items.length === 0;

  if (connection === undefined) return null;
  if (connection === null) return <Redirect href="/pairing" />;

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-row items-center justify-between px-4 pb-3">
        <View className="min-w-0 flex-1">
          <Text className="text-3xl font-semibold tracking-tight text-foreground">Sessions</Text>
          <Pressable
            onPress={() => router.push('/settings')}
            accessibilityLabel="Change connection"
            className="mt-2 flex-row items-center gap-1 self-start rounded-full border border-border/70 bg-card px-3 py-1.5 active:opacity-80"
          >
            <Server color="#83868b" size={13} />
            <Text className="max-w-52 text-[11px] text-muted-foreground" numberOfLines={1}>
              {connection.serverUrl}
            </Text>
            <ChevronRight color="#83868b" size={13} />
          </Pressable>
        </View>
        <Pressable
          accessibilityLabel="New task"
          onPress={() => router.push('/new')}
          className="h-11 w-11 items-center justify-center rounded-full bg-primary shadow-sm shadow-black/20 active:opacity-80"
        >
          <Plus color="#161719" size={21} strokeWidth={2.5} />
        </Pressable>
      </View>

      {pushDenied ? (
        <Card className="mx-4 mb-3 flex-row items-center gap-2 rounded-xl border-border/60 bg-secondary px-3 py-2 shadow-none">
          <Text className="flex-1 text-xs text-muted-foreground">
            Notifications are off — approvals and questions won’t reach this phone.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/settings')}
            className="min-h-11 justify-center px-1 active:opacity-70"
          >
            <Text className="text-xs font-semibold text-primary">Open Settings</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Dismiss notifications hint"
            onPress={() => setPushDenied(false)}
            className="min-h-11 w-8 items-center justify-center active:opacity-60"
          >
            <X color="#83868b" size={16} />
          </Pressable>
        </Card>
      ) : null}

      <View className="mx-4 mb-3 flex-row rounded-xl border border-border/60 bg-card p-1">
        {(['active', 'archived'] as const).map((item) => (
          <Pressable
            key={item}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === item }}
            onPress={() => setTab(item)}
            className={`min-h-10 flex-1 items-center justify-center rounded-lg ${tab === item ? 'bg-secondary' : ''}`}
          >
            <Text className={tab === item ? 'text-foreground' : 'text-muted-foreground'}>
              {item === 'active' ? 'Active' : 'Archived'}
            </Text>
          </Pressable>
        ))}
      </View>

      {error ? (
        <Text className="mx-4 mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</Text>
      ) : null}
      <FlatList
        style={{ flex: 1, minHeight: 0 }}
        data={items}
        keyExtractor={(item) => item.key}
        extraData={sessionPlans}
        renderItem={({ item }) => item.kind === 'session'
          ? <SessionRow
              session={item.session}
              steps={planStepsLabel(sessionPlans.get(item.session.id))}
              onPress={() => router.push(`/session/${item.session.id}`)}
            />
          : <CrewRunRow row={item.row} onPress={() => router.push(crewTaskPath(item.row.taskId))} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor="#9ca3af" />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24, paddingTop: 4 }}
        ListEmptyComponent={
          initialLoading ? (
            <HomeSkeleton />
          ) : (
            <EmptyState archived={tab === 'archived'} onCreate={() => router.push('/new')} />
          )
        }
      />
    </SafeAreaView>
  );
}

function HomeSkeleton() {
  return (
    <View className="gap-3 px-4 pt-1">
      {[0, 1, 2].map((item) => (
        <Card key={item} className="gap-0 rounded-2xl border-border/60 px-4 py-4 shadow-none">
          <View className="flex-row items-center justify-between">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </View>
          <Skeleton className="mt-4 h-5 w-4/5" />
          <Skeleton className="mt-2 h-3 w-2/5" />
          <View className="mt-4 flex-row justify-between">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-4 w-4 rounded-full" />
          </View>
        </Card>
      ))}
    </View>
  );
}

function EmptyState({ archived, onCreate }: { archived: boolean; onCreate: () => void }) {
  return (
    <View className="items-center px-8 py-16">
      <View className="h-12 w-12 items-center justify-center rounded-2xl bg-secondary">
        <Plus color="#eff0f1" size={22} />
      </View>
      <Text className="mt-4 text-center text-lg font-semibold text-foreground">
        {archived ? 'Nothing archived' : 'No sessions yet'}
      </Text>
      <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">
        {archived ? 'Completed sessions will appear here.' : 'Delegate a task and follow the agent from your phone.'}
      </Text>
      {!archived ? (
        <Button className="mt-6" onPress={onCreate}>
          <Text>Start a task</Text>
        </Button>
      ) : null}
    </View>
  );
}
