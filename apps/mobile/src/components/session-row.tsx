import { Pressable, View } from 'react-native';
import { statusLabel, type Session } from '@nuncio/core/api';
import { ATTENTION_COLOR, SessionStatusDot } from './session-status-dot';
import { Badge } from './ui/badge';
import { Card } from './ui/card';
import { Text } from './ui/text';
import { ChevronRight } from 'lucide-react-native';
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
  return (
    <Pressable
      onPress={onPress}
      className="mx-4 mb-3 active:opacity-80"
    >
      <Card className="gap-0 rounded-2xl border-border/70 px-4 py-4 shadow-none">
        <View className="flex-row items-center justify-between gap-3">
          <View className="flex-1 flex-row items-center gap-2">
            <SessionStatusDot status={session.status} pendingInput={pendingInput} />
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              Solo · {session.provider}{session.model ? ` · ${session.model}` : ''}
            </Text>
          </View>
          <Badge variant={statusBadgeVariant(session.status)}>
            <Text>{statusLabel(session.status)}</Text>
          </Badge>
        </View>
        <Text className="mt-3 font-semibold text-foreground" numberOfLines={1}>
          {session.title || session.prompt}
        </Text>
        <Text className="mt-1 text-xs text-muted-foreground" numberOfLines={1}>
          {pendingInput ? (
            <Text style={{ color: ATTENTION_COLOR }}>Waiting for you</Text>
          ) : (
            steps || 'No recent activity'
          )}
        </Text>
        <View className="mt-3 flex-row items-center justify-between">
          <Text className="text-[11px] text-muted-foreground">{relativeTimeLabel(session.updatedAt)}</Text>
          <ChevronRight color="#83868b" size={18} />
        </View>
      </Card>
    </Pressable>
  );
}
