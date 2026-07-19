import { Pressable, View } from 'react-native';
import type { CrewExecutionMode } from '../lib/crew-composer';
import { Text } from './ui/text';
import { Card } from './ui/card';
import { Bot, Users } from 'lucide-react-native';

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
    <Card className="mt-5 gap-0 rounded-2xl border-border/60 p-1 shadow-none">
      <View className="flex-row">
      {(['solo', 'crew'] as const).map((mode) => (
        <Pressable
          key={mode}
          accessibilityRole="radio"
          accessibilityState={{ checked: value === mode, disabled }}
          disabled={disabled}
          onPress={() => onChange(mode)}
          className={`min-h-11 flex-1 flex-row items-center justify-center gap-2 rounded-xl ${
            value === mode ? 'bg-secondary' : 'bg-transparent'
          }`}
        >
          {mode === 'solo' ? <Bot color={value === mode ? '#eff0f1' : '#83868b'} size={16} /> : <Users color={value === mode ? '#eff0f1' : '#83868b'} size={16} />}
          <Text className={value === mode ? 'font-semibold text-foreground' : 'text-muted-foreground'}>
            {mode === 'solo' ? 'Solo' : 'Crew'}
          </Text>
        </Pressable>
      ))}
      </View>
    </Card>
  );
}
