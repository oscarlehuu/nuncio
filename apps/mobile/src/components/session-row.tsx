import { Pressable, View } from 'react-native';
import { statusLabel, type Session } from '@nuncio/core/api';
import { ATTENTION_COLOR, SessionStatusDot } from './session-status-dot';
import { Badge } from './ui/badge';
import { Text } from './ui/text';
import { relativeTimeLabel } from '../lib/mobile-ui';
import { statusBadgeVariant } from '../lib/session-ui';

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
  const subtitle = steps || `Solo · ${session.provider}${session.model ? ` · ${session.model}` : ''}`;
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-start gap-3 px-4 py-3.5 active:bg-card"
    >
      <View className="mt-0.5">
        <SessionStatusDot status={session.status} pendingInput={pendingInput} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="flex-1 text-[15px] font-medium text-foreground" numberOfLines={1}>
            {session.title || session.prompt}
          </Text>
          <Text className="text-[11px] text-muted-foreground">
            {relativeTimeLabel(session.updatedAt)}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Text className="min-w-0 flex-1 text-xs text-muted-foreground" numberOfLines={1}>
            {pendingInput ? (
              <Text style={{ color: ATTENTION_COLOR }}>Waiting for you</Text>
            ) : (
              subtitle
            )}
          </Text>
          <Badge variant={statusBadgeVariant(session.status)}>
            <Text>{statusLabel(session.status)}</Text>
          </Badge>
        </View>
      </View>
    </Pressable>
  );
}
