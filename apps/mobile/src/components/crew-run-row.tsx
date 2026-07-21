import { Pressable, View } from 'react-native';
import type { CrewRunRowModel } from '../lib/crew-run-list';
import { Badge } from './ui/badge';
import { Text } from './ui/text';
import { Users } from 'lucide-react-native';
import { relativeTimeLabel } from '../lib/mobile-ui';

function label(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase());
}

export function CrewRunRow({ row, onPress }: { row: CrewRunRowModel; onPress: () => void }) {
  const variant = row.status === 'TERMINAL'
    ? 'outline'
    : row.status === 'RUNNING'
      ? 'default'
      : row.status.includes('BLOCKED')
        ? 'destructive'
        : 'secondary';
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-start gap-3 px-4 py-3.5 active:bg-card"
    >
      <View className="mt-0.5">
        <Users color="#9ca3af" size={15} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="flex-1 text-[15px] font-medium text-foreground" numberOfLines={1}>
            {row.objective}
          </Text>
          <Text className="text-[11px] text-muted-foreground">
            {relativeTimeLabel(row.updatedAt)}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Text className="min-w-0 flex-1 text-xs text-muted-foreground" numberOfLines={1}>
            Crew · {label(row.phase)}
          </Text>
          <Badge variant={variant}>
            <Text>{label(row.status)}</Text>
          </Badge>
        </View>
      </View>
    </Pressable>
  );
}
