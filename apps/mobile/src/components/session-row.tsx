import { Pressable, Text, View } from 'react-native';
import { relativeTime, type Session } from '@nuncio/core/api';

const STATUS_COLOR: Record<Session['status'], string> = {
  CREATED: '#9ca3af',
  RUNNING: '#22c55e',
  IDLE: '#60a5fa',
  PAUSED: '#eab308',
  ARCHIVED: '#6b7280',
  ERROR: '#ef4444',
};

export function SessionRow({ session, onPress }: { session: Session; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-card"
    >
      <View
        style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: STATUS_COLOR[session.status] }}
      />
      <View className="flex-1">
        <Text className="text-foreground" numberOfLines={1}>
          {session.title || session.prompt}
        </Text>
        <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
          {session.provider}
          {session.model ? ` · ${session.model}` : ''} · {relativeTime(session.updatedAt)}
        </Text>
      </View>
    </Pressable>
  );
}
