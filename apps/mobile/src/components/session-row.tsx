import { Pressable, Text, View } from 'react-native';
import { relativeTime, statusLabel, type Session } from '@nuncio/core/api';
import { ATTENTION_COLOR, SessionStatusDot } from './session-status-dot';

export function SessionRow({
  session,
  steps,
  onPress,
}: {
  session: Session;
  steps?: string | null;
  onPress: () => void;
}) {
  const pendingInput = session.status === 'RUNNING' && session.pendingInput === true;
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 border-b border-border px-4 py-3 active:bg-card"
    >
      <SessionStatusDot status={session.status} pendingInput={pendingInput} />
      <View className="flex-1">
        <Text className="text-foreground" numberOfLines={1}>
          {session.title || session.prompt}
        </Text>
        <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
          {pendingInput ? (
            <Text style={{ color: ATTENTION_COLOR }}>Waiting for you</Text>
          ) : (
            <>
              {session.provider}
              {session.model ? ` · ${session.model}` : ''} · {statusLabel(session.status)}
            </>
          )}
          {' · '}
          {relativeTime(session.updatedAt)}
          {!pendingInput && steps ? ` · ${steps}` : ''}
        </Text>
      </View>
    </Pressable>
  );
}
