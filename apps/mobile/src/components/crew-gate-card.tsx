import { Text, View } from 'react-native';
import type { CrewGateDto } from '@nuncio/core/crew-api';

export function CrewGateCard({ gate }: { gate: CrewGateDto }) {
  const label = gate.kind === 'verify' ? 'Verify' : 'Review';
  return (
    <View className="rounded-lg border border-border bg-card px-4 py-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="font-semibold text-foreground">{label}</Text>
        <Text className="text-xs uppercase text-muted-foreground">{gate.status.replace('_', ' ')}</Text>
      </View>
      {gate.workspaceHead ? (
        <Text className="mt-1 text-xs text-muted-foreground" numberOfLines={1}>
          Head {gate.workspaceHead.slice(0, 12)}
        </Text>
      ) : null}
      {gate.warnings.map((warning) => (
        <Text key={warning} className="mt-2 text-sm text-foreground">
          {warning}
        </Text>
      ))}
    </View>
  );
}
