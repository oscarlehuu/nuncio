import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import type { CrewRunCommand } from '@nuncio/core/crew-api';

type CrewAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'clarification'
  | 'extra-verify-round'
  | 'extra-review-round'
  | 'successor';

interface Props {
  actions: CrewAction[];
  busy: boolean;
  successorReady: boolean;
  onCommand: (command: CrewRunCommand, value?: string) => Promise<boolean>;
  onSuccessor: (changeRequest: string) => Promise<boolean>;
}

export function CrewRunActionPanel({ actions, busy, successorReady, onCommand, onSuccessor }: Props) {
  const [message, setMessage] = useState('');
  const clarification = actions.includes('clarification');
  const successor = actions.includes('successor');

  const submitMessage = async () => {
    const succeeded = clarification
      ? await onCommand('clarification', message)
      : await onSuccessor(message);
    if (succeeded) setMessage('');
  };

  return (
    <View className="gap-2 border-t border-border bg-background px-4 pb-2 pt-3">
      <View className="flex-row flex-wrap gap-2">
        {actions.includes('pause') ? <Action label="Pause" disabled={busy} onPress={() => void onCommand('pause')} /> : null}
        {actions.includes('resume') ? <Action label="Resume" disabled={busy} onPress={() => void onCommand('resume')} /> : null}
        {actions.includes('extra-verify-round') ? <Action label="One more verify round" disabled={busy} onPress={() => void onCommand('extra-round', 'verify')} /> : null}
        {actions.includes('extra-review-round') ? <Action label="One more review round" disabled={busy} onPress={() => void onCommand('extra-round', 'review')} /> : null}
        {actions.includes('cancel') ? <Action label="Cancel run" destructive disabled={busy} onPress={() => void onCommand('cancel')} /> : null}
      </View>

      {clarification || successor ? (
        <View>
          <Text className="mb-1 text-sm font-semibold text-foreground">
            {clarification ? 'Clarification' : 'Successor run'}
          </Text>
          <TextInput
            className="min-h-11 max-h-28 rounded-lg border border-border px-3 py-2 text-foreground"
            placeholder={clarification ? 'Answer the Crew’s question…' : 'Describe the changed request…'}
            placeholderTextColor="#6b7280"
            multiline
            value={message}
            onChangeText={setMessage}
          />
          <Pressable
            disabled={busy || !message.trim() || (successor && !successorReady)}
            onPress={() => void submitMessage()}
            className={`mt-2 min-h-11 items-center justify-center rounded-lg px-4 ${
              busy || !message.trim() || (successor && !successorReady) ? 'bg-muted' : 'bg-primary'
            }`}
          >
            {busy ? <ActivityIndicator size="small" /> : (
              <Text className="font-semibold text-primary-foreground">
                {clarification ? 'Send clarification' : 'Start successor run'}
              </Text>
            )}
          </Pressable>
          {successor && !successorReady ? (
            <Text className="mt-1 text-xs text-muted-foreground">A workspace head is required for a successor.</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Action({
  label,
  disabled,
  destructive = false,
  onPress,
}: {
  label: string;
  disabled: boolean;
  destructive?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      className={`min-h-11 justify-center rounded-lg px-4 ${destructive ? 'bg-destructive' : 'bg-secondary'}`}
    >
      <Text className={destructive ? 'font-medium text-destructive-foreground' : 'font-medium text-foreground'}>{label}</Text>
    </Pressable>
  );
}
