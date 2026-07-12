import { Text, View } from 'react-native';

interface CrewRunProgressProps {
  steps: Array<{ label: string; state: string }>;
}

export function CrewRunProgress({ steps }: CrewRunProgressProps) {
  return (
    <View className="mt-4 gap-2" accessibilityRole="summary">
      {steps.map((step, index) => (
        <View key={step.label} className="flex-row items-center gap-3">
          <View
            className={`h-7 w-7 items-center justify-center rounded-full border ${
              step.state === 'complete'
                ? 'border-primary bg-primary'
                : step.state === 'current'
                  ? 'border-primary bg-secondary'
                  : step.state === 'failed'
                    ? 'border-destructive bg-destructive/10'
                    : step.state === 'cancelled'
                      ? 'border-border bg-muted'
                  : 'border-border bg-card'
            }`}
          >
            <Text
              className={step.state === 'complete' ? 'text-primary-foreground' : 'text-foreground'}
            >
              {step.state === 'complete' ? '✓' : step.state === 'failed' ? '×' : step.state === 'cancelled' ? '—' : index + 1}
            </Text>
          </View>
          <Text
            className={step.state === 'upcoming' ? 'text-muted-foreground' : 'text-foreground'}
            accessibilityState={{ selected: step.state === 'current' }}
          >
            {step.label}
            {step.state === 'current' ? ' · current' : ''}
            {step.state === 'unknown' ? ' · completion unknown' : ''}
            {step.state === 'failed' ? ' · failed' : ''}
            {step.state === 'cancelled' ? ' · cancelled' : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}
