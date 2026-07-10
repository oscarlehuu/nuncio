import { Pressable, Text, View } from 'react-native';
import { relativeTime } from '@nuncio/core/api';
import type { CrewRunRowModel } from '../lib/crew-run-list';

const STATUS_COLOR: Record<CrewRunRowModel['status'], string> = {
  QUEUED: '#9ca3af',
  RUNNING: '#22c55e',
  BLOCKED_USER: '#f59e0b',
  BLOCKED_PROVIDER: '#ef4444',
  PAUSED: '#eab308',
  RECOVERING: '#60a5fa',
  TERMINAL: '#6b7280',
};

function label(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase());
}

export function CrewRunRow({ row, onPress }: { row: CrewRunRowModel; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} className="min-h-11 flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-card">
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: STATUS_COLOR[row.status] }} />
      <View className="flex-1">
        <Text className="text-foreground" numberOfLines={1}>{row.objective}</Text>
        <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
          Crew · {label(row.phase)} · {label(row.status)} · {relativeTime(row.updatedAt)}
        </Text>
      </View>
    </Pressable>
  );
}
