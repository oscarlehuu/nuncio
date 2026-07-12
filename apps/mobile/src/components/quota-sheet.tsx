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

const USAGE_BAR_HIGH = '#f59e0b';
const USAGE_BAR_CRITICAL = '#f5605b';

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

function formatQuotaLabel(usedPercent: number, mode: PercentMode): string {
  const value = displayPercent(usedPercent, mode);
  return `${value}% ${mode}`;
}

function usageBarColor(usedPercent: number): string {
  if (usedPercent > 90) return USAGE_BAR_CRITICAL;
  if (usedPercent > 70) return USAGE_BAR_HIGH;
  return '#e4e4e4';
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

function PercentModeToggle({
  mode,
  onChange,
}: {
  mode: PercentMode;
  onChange: (mode: PercentMode) => void;
}) {
  return (
    <View
      className="mt-3 flex-row rounded-lg border border-border/60 p-0.5"
      accessibilityRole="tablist"
    >
      {(['used', 'left'] as const).map((option) => {
        const selected = mode === option;
        return (
          <Pressable
            key={option}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(option)}
            className={`flex-1 items-center rounded-md px-3 py-1.5 ${selected ? 'bg-muted' : ''}`}
          >
            <Text
              className={`text-xs font-medium capitalize ${selected ? 'text-foreground' : 'text-muted-foreground'}`}
            >
              {option}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
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

  const chipLabel = reset
    ? `${formatQuotaLabel(used, mode)} · ${reset}`
    : formatQuotaLabel(used, mode);

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
        <Text className="font-mono text-xs tabular-nums text-muted-foreground">{chipLabel}</Text>
      </Pressable>

      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <Pressable className="flex-1 bg-black/50" onPress={() => setOpen(false)} />
        <View className="max-h-[75%] rounded-t-2xl border-t border-border bg-background px-5 pb-10 pt-3">
          <View className="mb-4 items-center">
            <View className="mb-3 h-1 w-10 rounded-full bg-muted" />
            <Text className="text-lg font-semibold text-foreground">Provider quota</Text>
            <Text className="mt-1 text-center text-xs text-muted-foreground">
              Subscription limits from your local CLI logins
            </Text>
            <PercentModeToggle mode={mode} onChange={setMode} />
          </View>

          {error ? (
            <Text className="mb-3 text-sm text-destructive">{error}</Text>
          ) : null}

          <ScrollView className="mb-3" showsVerticalScrollIndicator={false}>
            {ordered.map((snapshot) => {
              const emphasized =
                isUsageProviderId(resolvedProvider) && snapshot.provider === resolvedProvider;
              return (
                <View
                  key={snapshot.provider}
                  className={`mb-3 rounded-xl border p-3 ${
                    emphasized ? 'border-border bg-card' : 'border-border/50 bg-background'
                  }`}
                >
                  <Text className="mb-2 text-sm font-semibold text-foreground">
                    {PROVIDER_LABEL[snapshot.provider]}
                    {snapshot.planName ? (
                      <Text className="font-normal text-muted-foreground"> · {snapshot.planName}</Text>
                    ) : null}
                  </Text>

                  {snapshot.status === 'ok' ? (
                    snapshot.limits.map((limit) => {
                      const usedPercent = limit.usedPercent;
                      const hasPercent = typeof usedPercent === 'number';
                      const resetLabel = limit.resetsAt
                        ? formatResetCountdown(limit.resetsAt)
                        : null;
                      return (
                        <View key={limit.window} className="mb-3 last:mb-0">
                          <View className="mb-1 flex-row items-baseline justify-between gap-3">
                            <Text className="flex-1 text-sm text-muted-foreground">{limit.window}</Text>
                            <Text className="shrink-0 font-mono text-sm tabular-nums text-foreground">
                              {hasPercent ? formatQuotaLabel(usedPercent, mode) : '—'}
                              {resetLabel ? (
                                <Text className="font-mono text-xs text-muted-foreground">
                                  {' '}
                                  · {resetLabel}
                                </Text>
                              ) : null}
                            </Text>
                          </View>
                          {hasPercent ? (
                            <View className="h-1.5 overflow-hidden rounded-full bg-muted/60">
                              <View
                                style={{
                                  width: `${Math.min(100, Math.max(0, usedPercent))}%`,
                                  backgroundColor: usageBarColor(usedPercent),
                                }}
                                className="h-full rounded-full"
                              />
                            </View>
                          ) : null}
                        </View>
                      );
                    })
                  ) : (
                    <Text className="text-sm text-muted-foreground">
                      {snapshot.detail ?? usageNeedsAuthHint(snapshot.provider)}
                    </Text>
                  )}

                  {snapshot.usageLines.length > 0 ? (
                    <View className="mt-3 border-t border-border/40 pt-2">
                      {snapshot.usageLines.map((line) => (
                        <View key={line.label} className="mb-2 last:mb-0">
                          <View className="flex-row items-baseline justify-between gap-3">
                            <Text className="text-sm text-muted-foreground">{line.label}</Text>
                            <Text className="shrink-0 font-mono text-sm tabular-nums text-foreground">
                              {line.value}
                            </Text>
                          </View>
                          {line.subtitle ? (
                            <Text className="mt-0.5 text-xs text-muted-foreground">{line.subtitle}</Text>
                          ) : null}
                        </View>
                      ))}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>

          {sharedUpdated ? (
            <Text className="mb-3 text-center font-mono text-xs tabular-nums text-muted-foreground">
              Updated {formatUpdatedAgo(sharedUpdated)}
            </Text>
          ) : null}

          <Pressable
            onPress={() => setOpen(false)}
            className="items-center rounded-xl bg-muted px-4 py-3"
          >
            <Text className="font-medium text-foreground">Close</Text>
          </Pressable>
        </View>
      </Modal>
    </>
  );
}
