import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  SectionList,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { ChevronRight, Server, X } from 'lucide-react-native';
import { fetchArchivedSessions, fetchSessions, type Session } from '@nuncio/core/api';
import { applyConnection, updateActiveSecret } from '../../lib/api-setup';
import { clearConnection, loadConnection, type ConnectionConfig } from '../../lib/connection-store';
import { secureStore } from '../../lib/secure-store-adapter';
import { registerForPush } from '../../lib/push-registration';
import { rotateDeviceSecret } from '../../lib/rotate-secret';
import { useSessionPlans } from '../../lib/use-session-plans';
import { planStepsLabel } from '../../lib/session-plan-progress';
import { buildHomeSections, type HomeItem } from '../../lib/home-sections';
import { HomeComposer } from '../../components/home-composer';
import { SessionRow } from '../../components/session-row';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import { Text } from '../../components/ui/text';

type Tab = 'active' | 'archived';
type HomeSection = { key: string; title: string; data: HomeItem[] };

// The pill only needs the host — the https:// prefix and trailing slash are
// noise that push the meaningful machine name out of the truncated label.
function serverLabel(serverUrl: string): string {
  return serverUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

export default function SessionList() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [connection, setConnection] = useState<ConnectionConfig | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('active');
  const [sessions, setSessions] = useState<Session[]>([]);
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
      } else {
        const sessionList = await fetchSessions();
        setSessions(sessionList.filter((session) => session.status !== 'ARCHIVED'));
      }
      setError(null);
    } catch {
      setError('Could not load work. Check the connection.');
    } finally {
      setRefreshing(false);
    }
  }, [connection, tab]);

  useFocusEffect(useCallback(() => {
    void refresh();
  }, [refresh]));

  const items = useMemo<HomeItem[]>(() => {
    const sessionItems: HomeItem[] = sessions.map((session) => ({
      kind: 'session',
      key: `session:${session.id}`,
      updatedAt: session.updatedAt,
      session,
    }));
    return sessionItems.sort(
      (a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key),
    );
  }, [sessions]);

  const sessionPlans = useSessionPlans(sessions);
  const initialLoading = refreshing && items.length === 0;
  const sections = useMemo<HomeSection[]>(
    () => tab === 'active'
      ? buildHomeSections(items)
      : [{ key: 'archived', title: 'Archived', data: items }],
    [items, tab],
  );

  if (connection === undefined) return null;
  if (connection === null) return <Redirect href="/pairing" />;

  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
        className="flex-1"
        style={{ flex: 1 }}
      >
        <SectionList
          style={{ flex: 1, minHeight: 0 }}
          sections={sections}
          keyExtractor={(item) => item.key}
          extraData={sessionPlans}
          ItemSeparatorComponent={() => <View className="mx-4 h-px bg-border" />}
          renderItem={({ item }) => (
            <SessionRow
              session={item.session}
              steps={planStepsLabel(sessionPlans.get(item.session.id))}
              onPress={() => router.push(`/session/${item.session.id}`)}
            />
          )}
          renderSectionHeader={({ section }) => (
            <Text className="px-4 pb-2 pt-5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {section.title}
            </Text>
          )}
          ListHeaderComponent={(
            <HomeHeader
              connection={connection}
              pushDenied={pushDenied}
              tab={tab}
              onChangeConnection={() => router.push('/settings')}
              onDismissPush={() => setPushDenied(false)}
              onOpenSettings={() => router.push('/settings')}
              onAdvanced={() => router.push('/new')}
              onCreated={(session) => router.push(`/session/${session.id}`)}
              onTabChange={setTab}
            />
          )}
          ListEmptyComponent={
            initialLoading
              ? <HomeSkeleton />
              : <EmptyState archived={tab === 'archived'} onCreate={() => router.push('/new')} />
          }
          ListFooterComponent={
            error
              ? <Text className="mx-4 mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</Text>
              : null
          }
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor="#9ca3af" />}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          keyboardShouldPersistTaps="handled"
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function HomeHeader({
  connection,
  pushDenied,
  tab,
  onChangeConnection,
  onDismissPush,
  onOpenSettings,
  onAdvanced,
  onCreated,
  onTabChange,
}: {
  connection: ConnectionConfig;
  pushDenied: boolean;
  tab: Tab;
  onChangeConnection: () => void;
  onDismissPush: () => void;
  onOpenSettings: () => void;
  onAdvanced: () => void;
  onCreated: (session: Session) => void;
  onTabChange: (tab: Tab) => void;
}) {
  return (
    <>
      <View className="px-4 pb-3">
        <View className="flex-row items-center justify-between">
          <Text className="text-2xl font-semibold tracking-tight text-foreground">Nuncio</Text>
          <Pressable
            onPress={onChangeConnection}
            accessibilityLabel="Change connection"
            className="max-w-[60%] flex-row items-center gap-1 rounded-full border border-border bg-card px-3 py-1.5 active:opacity-80"
          >
            <Server color="#83868b" size={13} />
            <Text className="max-w-48 text-[11px] text-muted-foreground" numberOfLines={1}>
              {serverLabel(connection.serverUrl)}
            </Text>
            <ChevronRight color="#83868b" size={13} />
          </Pressable>
        </View>
      </View>

      <HomeComposer onCreated={onCreated} onAdvanced={onAdvanced} />

      {pushDenied ? (
        <Card className="mx-4 mb-3 flex-row items-center gap-2 rounded-xl border-border bg-secondary px-3 py-2 shadow-none">
          <Text className="flex-1 text-xs text-muted-foreground">
            Notifications are off — approvals and questions won’t reach this phone.
          </Text>
          <Pressable accessibilityRole="button" onPress={onOpenSettings} className="min-h-11 justify-center px-1 active:opacity-70">
            <Text className="text-xs font-semibold text-primary">Open Settings</Text>
          </Pressable>
          <Pressable accessibilityLabel="Dismiss notifications hint" onPress={onDismissPush} className="min-h-11 w-8 items-center justify-center active:opacity-60">
            <X color="#83868b" size={16} />
          </Pressable>
        </Card>
      ) : null}

      <View className="mx-4 mb-1 flex-row rounded-xl border border-border bg-card p-1">
        {(['active', 'archived'] as const).map((item) => (
          <Pressable
            key={item}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === item }}
            onPress={() => onTabChange(item)}
            className={`min-h-10 flex-1 items-center justify-center rounded-lg ${tab === item ? 'bg-secondary' : ''}`}
          >
            <Text className={tab === item ? 'text-foreground' : 'text-muted-foreground'}>
              {item === 'active' ? 'Recent' : 'Archived'}
            </Text>
          </Pressable>
        ))}
      </View>
    </>
  );
}

function HomeSkeleton() {
  return (
    <View className="pt-2">
      {[0, 1, 2, 3].map((item) => (
        <View key={item} className="flex-row items-start gap-3 px-4 py-3.5">
          <Skeleton className="mt-1 h-3 w-3 rounded-full" />
          <View className="flex-1 gap-2">
            <View className="flex-row items-center justify-between">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-10" />
            </View>
            <View className="flex-row items-center justify-between">
              <Skeleton className="h-3 w-2/5" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

function EmptyState({ archived, onCreate }: { archived: boolean; onCreate: () => void }) {
  return (
    <View className="items-center px-8 py-16">
      <Text className="text-center text-lg font-semibold text-foreground">
        {archived ? 'Nothing archived' : 'No recent work'}
      </Text>
      <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">
        {archived ? 'Completed sessions will appear here.' : 'Compose a task above and follow the agent from your phone.'}
      </Text>
      {!archived ? (
        <Button className="mt-6" onPress={onCreate}>
          <Text>Start a task</Text>
        </Button>
      ) : null}
    </View>
  );
}
