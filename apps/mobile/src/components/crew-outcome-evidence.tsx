import { Text, View } from 'react-native';
import type { CrewOutcomeEvidence as OutcomeEvidence } from '@nuncio/core/crew-api';

export function CrewOutcomeEvidence({ evidence }: { evidence: OutcomeEvidence | null }) {
  if (!evidence) return null;
  if (evidence.state === 'incomplete') {
    return (
      <View accessibilityRole="alert" className="mt-5 rounded-lg border border-border bg-card px-4 py-3">
        <Text className="font-semibold text-foreground">Outcome evidence unavailable</Text>
        <Text className="mt-1 text-sm text-muted-foreground">{evidence.warning}</Text>
        <ReviewWarnings warnings={evidence.reviewWarnings} />
      </View>
    );
  }
  return (
    <View className="mt-5 rounded-lg border border-border bg-card px-4 py-4">
      <Text className="font-semibold text-foreground">Outcome</Text>
      <Text className="mt-2 text-foreground">{evidence.summary}</Text>
      <Label>Foreman verification summary</Label>
      <Text className="mt-1 text-sm text-foreground">{evidence.verification}</Text>
      <Label>Remaining risks</Label>
      {evidence.remainingRisks.length ? evidence.remainingRisks.map((risk) => (
        <Text key={risk} className="mt-1 text-sm text-foreground">• {risk}</Text>
      )) : <Text className="mt-1 text-sm text-muted-foreground">No remaining risks reported.</Text>}
      <ReviewWarnings warnings={evidence.reviewWarnings} />
    </View>
  );
}

function Label({ children }: { children: string }) {
  return <Text className="mt-4 text-sm font-semibold text-muted-foreground">{children}</Text>;
}

function ReviewWarnings({ warnings }: { warnings: Array<{ title: string; body: string }> }) {
  if (!warnings.length) return null;
  return (
    <View className="mt-4">
      <Text className="text-sm font-semibold text-muted-foreground">Nonblocking review warnings</Text>
      {warnings.map((warning) => (
        <Text key={`${warning.title}:${warning.body}`} className="mt-1 text-sm text-foreground">
          <Text className="font-semibold">{warning.title}</Text> · {warning.body}
        </Text>
      ))}
    </View>
  );
}
