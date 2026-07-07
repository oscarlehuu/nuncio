import { Text, View } from 'react-native';
import type { ConnectionState } from '../lib/connection-manager';

/**
 * Compact status dot + label reflecting the connection manager's state. Hidden
 * while healthy ('connected') so it only draws attention when something needs
 * it — reconnecting, offline, or the desktop went away.
 */
const LABELS: Record<Exclude<ConnectionState, 'connected'>, { text: string; dot: string }> = {
  connecting: { text: 'Connecting…', dot: 'bg-primary' },
  offline: { text: 'Offline', dot: 'bg-muted-foreground' },
  'server-shutdown': { text: 'Desktop offline', dot: 'bg-destructive' },
};

export function ConnectionPill({ state }: { state: ConnectionState }) {
  if (state === 'connected') return null;
  const { text, dot } = LABELS[state];
  return (
    <View className="flex-row items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1">
      <View className={`h-2 w-2 rounded-full ${dot}`} />
      <Text className="text-xs text-foreground">{text}</Text>
    </View>
  );
}
