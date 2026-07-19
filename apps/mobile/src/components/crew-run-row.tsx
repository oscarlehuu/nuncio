import { Pressable, View } from 'react-native';
import type { CrewRunRowModel } from '../lib/crew-run-list';
import { Badge } from './ui/badge';
import { Card } from './ui/card';
import { Text } from './ui/text';
import { ChevronRight, Users } from 'lucide-react-native';
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
    <Pressable onPress={onPress} className="mx-4 mb-3 active:opacity-80">
      <Card className="gap-0 rounded-2xl border-border/70 px-4 py-4 shadow-none">
        <View className="flex-row items-center justify-between gap-3">
          <View className="flex-1 flex-row items-center gap-2">
            <Users color="#9ca3af" size={15} />
            <Text className="text-xs text-muted-foreground">Crew run</Text>
          </View>
          <Badge variant={variant}>
            <Text>{label(row.status)}</Text>
          </Badge>
        </View>
        <Text className="mt-3 font-semibold text-foreground" numberOfLines={2}>{row.objective}</Text>
        <Text className="mt-1 text-xs text-muted-foreground" numberOfLines={1}>
          {label(row.phase)} · {label(row.status)}
        </Text>
        <View className="mt-3 flex-row items-center justify-between">
          <Text className="text-[11px] text-muted-foreground">{relativeTimeLabel(row.updatedAt)}</Text>
          <ChevronRight color="#83868b" size={18} />
        </View>
      </Card>
    </Pressable>
  );
}
