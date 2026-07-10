import { Pressable, ScrollView, Text, View } from 'react-native';
import type { CrewRunDto } from '@nuncio/core/crew-api';
import { buildCrewRunHistory } from '../lib/crew-run-history';

export function CrewRunHistory({
  runs,
  selectedRunId,
  onSelect,
}: {
  runs: CrewRunDto[];
  selectedRunId: string;
  onSelect: (runId: string) => void;
}) {
  if (runs.length < 2) return null;
  const items = buildCrewRunHistory(runs, selectedRunId);
  return (
    <View className="mb-4" accessibilityLabel="Crew run history">
      <Text className="mb-2 text-sm font-semibold text-muted-foreground">Run history</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
        {items.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={`Run ${item.number}, ${item.phase}, ${item.state}`}
            accessibilityState={{ selected: item.selected }}
            onPress={() => onSelect(item.id)}
            className={`min-h-11 min-w-32 justify-center rounded-lg border px-3 py-2 ${
              item.selected ? 'border-primary bg-secondary' : 'border-border bg-card'
            }`}
          >
            <Text className="font-medium text-foreground">Run {item.number}</Text>
            <Text className="text-xs text-muted-foreground">{item.phase} · {item.state}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
