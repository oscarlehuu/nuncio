import { Pressable, Text, View } from 'react-native';
import type { CrewExecutionMode } from '../lib/crew-composer';

export function CrewModePicker({
  value,
  disabled,
  onChange,
}: {
  value: CrewExecutionMode;
  disabled: boolean;
  onChange: (value: CrewExecutionMode) => void;
}) {
  return (
    <View className="mt-5 flex-row rounded-lg border border-border p-1">
      {(['solo', 'crew'] as const).map((mode) => (
        <Pressable
          key={mode}
          accessibilityRole="radio"
          accessibilityState={{ checked: value === mode, disabled }}
          disabled={disabled}
          onPress={() => onChange(mode)}
          className={`min-h-11 flex-1 items-center justify-center rounded-md ${
            value === mode ? 'bg-secondary' : 'bg-transparent'
          }`}
        >
          <Text className={value === mode ? 'font-semibold text-foreground' : 'text-muted-foreground'}>
            {mode === 'solo' ? 'Solo' : 'Crew'}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
