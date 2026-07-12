import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, type AppStateStatus, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import {
  fetchProviderUsage,
  type UsageProviderId,
  type UsageSnapshotDto,
} from '@nuncio/core/usage-api';
import {
  findUsageSnapshotForProvider,
  resolveUsageProvider,
  usageNeedsAuthHint,
} from '@nuncio/core/usage-resolve';

const PROVIDER_LABEL: Record<UsageProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
};

type PercentMode = 'used' | 'left';

function isUsageProviderId(value: string | null | undefined): value is UsageProviderId {
  return value === 'claude' || value === 'codex' || value === 'cursor';
}

function primaryLimit(snapshot: UsageSnapshotDto | null) {
  if (!snapshot || snapshot.status !== 'ok') return null;
  const withPercent = snapshot.limits.filter((l) => typeof l.usedPercent === 'number');
  return (
    withPercent.find((l) => /session|5h|current|total/i.test(l.window)) ?? withPercent[0] ?? null
  );
}

function displayPercent(used: number, mode: PercentMode): number {
  return Math.round(mode === 'left' ? Math.max(0, 100 - used) : used);
}

function formatResetCountdown(resetsAt: string | undefined): string | null {
  if (!resetsAt) return null;
  const target = Date.parse(resetsAt);
  if (Number.isNaN(target)) return null;
  const mins = Math.max(0, Math.round((target - Date.now()) / 60_000));
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatUpdatedAgo(updatedAt: string): string {
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.floor((Date.now() - then) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function freshestUpdatedAt(snapshots: UsageSnapshotDto[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const snap of snapshots) {
    if (snap.status !== 'ok' || !snap.updatedAt) continue;
    const ms = Date.parse(snap.updatedAt);
    if (!Number.isNaN(ms) && ms > bestMs) {
      bestMs = ms;
      best = snap.updatedAt;
    }
  }
  return best;
}

interface QuotaSheetProps {
  activeProvider?: string | null;
  model?: string | null;
}

export function QuotaSheetTrigger({ activeProvider, model }: QuotaSheetProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PercentMode>('used');
  const [snapshots, setSnapshots] = useState<UsageSnapshotDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const resolvedProvider = resolveUsageProvider(activeProvider, model);

  const load = useCallback(async (forceRefresh = false) => {
    try {
      const next = await fetchProviderUsage({ forceRefresh });
      setSnapshots(next);
      setError(null);
    } catch (err) {
      setError((err as Error)?.message ?? 'Failed to load usage');
    }
  }, []);

  useEffect(() => {
    void load(false);
    const id = setInterval(() => void load(false), 30_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    const onChange = (state: AppStateStatus) => {
      if (state === 'active') void load(false);
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [load]);

  const ordered = useMemo(() => {
    if (!isUsageProviderId(resolvedProvider)) return snapshots;
    const active = snapshots.find((s) => s.provider === resolvedProvider);
    if (!active) return snapshots;
    return [active, ...snapshots.filter((s) => s.provider !== resolvedProvider)];
  }, [snapshots, resolvedProvider]);

  const activeSnap = findUsageSnapshotForProvider(snapshots, resolvedProvider);
  const primary = primaryLimit(activeSnap);
  const used = primary?.usedPercent;
  const reset = formatResetCountdown(primary?.resetsAt);
  const sharedUpdated = freshestUpdatedAt(snapshots);

  if (used == null) {
    return null;
  }

  const shown = displayPercent(used, mode);
  const chipLabel = reset ? `${shown}% · ${reset}` : `${shown}%`;

  return (
    <>
      <Pressable
        onPress={() => {
          setOpen(true);
          void load(true);
        }}
        className="rounded-full border border-border px-2.5 py-1"
        accessibilityLabel="Provider quota"
        testID="quota-chip"
      >
        <Text className="text-xs tabular-nums text-muted-foreground">{chipLabel}</Text>
      </Pressable>

      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <Pressable className="flex-1 bg-black/40" onPress={() => setOpen(false)} />
        <View className="max-h-[70%] rounded-t-2xl border-t border-border bg-background px-4 pb-10 pt-3">
          <View className="mb-3 items-center">
            <View className="mb-2 h-1 w-10 rounded-full bg-muted" />
            <Text className="text-base font-semibold text-foreground">Provider quota</Text>
            <View className="mt-2 flex-row gap-2">
              {(['used', 'left'] as const).map((option) => (
                <Pressable
                  key={option}
                  onPress={() => setMode(option)}
                  className={`rounded-full px-3 py-1 ${mode === option ? 'bg-muted' : ''}`}
                >
                  <Text className="text-xs capitalize text-foreground">{option}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          {error ? <Text className="mb-2 text-sm text-destructive">{error}</Text> : null}
          <ScrollView>
            {ordered.map((snapshot) => (
              <View key={snapshot.provider} className="mb-4 border-b border-border pb-3">
                <Text className="mb-1 font-medium text-foreground">
                  {PROVIDER_LABEL[snapshot.provider]}
                  {snapshot.planName ? ` · ${snapshot.planName}` : ''}
                </Text>
                {snapshot.status === 'ok' ? (
                  snapshot.limits.map((limit) => (
                    <View key={limit.window} className="mb-1 flex-row justify-between">
                      <Text className="text-sm text-muted-foreground">{limit.window}</Text>
                      <Text className="text-sm tabular-nums text-foreground">
                        {typeof limit.usedPercent === 'number'
                          ? `${displayPercent(limit.usedPercent, mode)}% ${mode}`
                          : '—'}
                        {limit.resetsAt ? ` · ${formatResetCountdown(limit.resetsAt) ?? ''}` : ''}
                      </Text>
                    </View>
                  ))
                ) : (
                  <Text className="text-sm text-muted-foreground">
                    {snapshot.detail ?? usageNeedsAuthHint(snapshot.provider)}
                  </Text>
                )}
                {snapshot.usageLines.map((line) => (
                  <View key={line.label} className="mt-1">
                    <View className="flex-row justify-between">
                      <Text className="text-sm text-muted-foreground">{line.label}</Text>
                      <Text className="text-sm text-foreground">{line.value}</Text>
                    </View>
                    {line.subtitle ? (
                      <Text className="text-xs text-muted-foreground">{line.subtitle}</Text>
                    ) : null}
                  </View>
                ))}
              </View>
            ))}
          </ScrollView>
          {sharedUpdated ? (
            <Text className="mb-2 text-center text-xs text-muted-foreground">
              Updated {formatUpdatedAgo(sharedUpdated)}
            </Text>
          ) : null}
          <Pressable
            onPress={() => setOpen(false)}
            className="mt-2 items-center rounded-lg bg-muted px-4 py-3"
          >
            <Text className="font-medium text-foreground">Close</Text>
          </Pressable>
        </View>
      </Modal>
    </>
  );
}
