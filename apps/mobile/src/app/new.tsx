import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { createSession, fetchModels } from '@nuncio/core/api';
import {
  flattenProviders,
  pickDefaultModelSelection,
  type FlatModel,
  type ModelProvider,
} from '@nuncio/core/model-providers';

export default function NewSession() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchModels().then((catalog) => {
      setProviders(catalog);
      const preferred = pickDefaultModelSelection(catalog);
      if (preferred) setModelId(preferred.modelId);
    });
  }, []);

  const models = useMemo(() => flattenProviders(providers), [providers]);
  const selected: FlatModel | undefined = models.find((m) => m.id === modelId);

  const create = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await createSession(prompt.trim(), selected?.id, selected?.providerId);
      router.replace(`/session/${session.id}`);
    } catch {
      setError('Could not create the session.');
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-background pt-16"
    >
      <View className="flex-row items-center justify-between px-4 pb-3">
        <Text className="text-2xl font-semibold text-foreground">New session</Text>
        <Pressable onPress={() => router.back()}>
          <Text className="text-muted-foreground">Cancel</Text>
        </Pressable>
      </View>

      <View className="flex-1 px-4">
        <TextInput
          className="min-h-32 rounded-lg border border-border px-4 py-3 text-foreground"
          placeholder="What should the agent work on?"
          placeholderTextColor="#6b7280"
          multiline
          value={prompt}
          onChangeText={setPrompt}
        />

        <Text className="mt-6 text-sm text-muted-foreground">Model</Text>
        <ScrollView className="mt-2 max-h-64 rounded-lg border border-border">
          {models.map((m) => (
            <Pressable
              key={m.id}
              onPress={() => setModelId(m.id)}
              className={`border-b border-border px-4 py-3 ${m.id === modelId ? 'bg-secondary' : ''}`}
            >
              <Text className="text-foreground">{m.name}</Text>
              <Text className="text-xs text-muted-foreground">
                {m.providerName}
                {m.groupName ? ` · ${m.groupName}` : ''}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        {error ? <Text className="mt-3 text-sm text-destructive">{error}</Text> : null}

        <Pressable
          onPress={create}
          disabled={busy || !prompt.trim()}
          className={`mt-6 items-center rounded-lg px-4 py-3 ${busy || !prompt.trim() ? 'bg-muted' : 'bg-primary'}`}
        >
          {busy ? (
            <ActivityIndicator />
          ) : (
            <Text className="font-semibold text-primary-foreground">Delegate</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
