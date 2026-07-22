import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ArrowLeft, Bot, Send } from 'lucide-react-native';
import { createSession, fetchModels } from '@nuncio/core/api';
import {
  flattenProviders,
  pickDefaultModelSelection,
  type FlatModel,
  type ModelProvider,
} from '@nuncio/core/model-providers';
import { createSubmitLock } from '../lib/submit-lock';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Text } from '../components/ui/text';
import { Textarea } from '../components/ui/textarea';

export default function NewSession() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [prompt, setPrompt] = useState('');
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [promptHeight, setPromptHeight] = useState(144);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitLock = useRef(createSubmitLock());

  useEffect(() => {
    fetchModels()
      .then((catalog) => {
        setProviders(catalog);
        const preferred = pickDefaultModelSelection(catalog);
        if (preferred) setModelId(preferred.modelId);
      })
      .catch(() => setError('Could not load available models.'));
  }, []);

  const models = useMemo(() => flattenProviders(providers), [providers]);
  const selected: FlatModel | undefined = models.find((model) => model.id === modelId);
  const canDelegate = Boolean(prompt.trim() && !busy && selected);

  const submit = async () => {
    if (!canDelegate || !selected || !submitLock.current.tryAcquire()) return;
    setBusy(true);
    setError(null);
    try {
      const session = await createSession(prompt.trim(), selected.id, selected.providerId);
      router.replace(`/session/${session.id}`);
    } catch {
      setError('Could not create the session.');
    } finally {
      submitLock.current.release();
      setBusy(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-background" style={{ flex: 1 }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
        className="flex-1"
        style={{ flex: 1 }}
      >
        <View className="flex-row items-center gap-3 px-4 pb-3">
          <Pressable
            accessibilityLabel="Close new task"
            onPress={() => router.back()}
            className="h-9 w-9 items-center justify-center rounded-full active:bg-card"
          >
            <ArrowLeft color="#eff0f1" size={21} />
          </Pressable>
          <View>
            <Text className="text-2xl font-semibold tracking-tight text-foreground">New task</Text>
            <Text className="mt-1 text-sm text-muted-foreground">
              Delegate work to an agent.
            </Text>
          </View>
        </View>

        <ScrollView
          className="flex-1 px-4"
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          <Card className="gap-0 rounded-xl border-border p-4 shadow-none">
            <View className="mb-3 flex-row items-center gap-2">
              <Bot color="#208aef" size={17} />
              <Text className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                Agent
              </Text>
            </View>
            <Textarea
            className="min-h-36 border-0 bg-transparent px-0 py-0 text-base leading-6 shadow-none"
            style={{ height: promptHeight }}
            placeholder="What should the agent work on?"
            placeholderTextColor="#6b7280"
            multiline
            numberOfLines={8}
            value={prompt}
            onChangeText={setPrompt}
            onContentSizeChange={(event) => {
              setPromptHeight(Math.min(260, Math.max(144, event.nativeEvent.contentSize.height)));
            }}
            />
            <Text className="mt-3 text-xs text-muted-foreground">
              Describe the outcome, constraints, and anything the agent should inspect.
            </Text>
          </Card>

          <View className="mt-5">
            <View className="mb-2 flex-row items-center justify-between">
              <Text className="text-sm font-medium text-foreground">Agent model</Text>
              <Text className="text-xs text-muted-foreground">Choose a provider</Text>
            </View>
            <Card className="gap-0 overflow-hidden rounded-xl border-border p-1 shadow-none">
              {models.map((model) => (
                <Pressable
                  key={`${model.providerId}:${model.id}`}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: model.id === modelId }}
                  onPress={() => setModelId(model.id)}
                  className={`min-h-14 flex-row items-center justify-between rounded-xl border-b border-border px-3 py-2 ${model.id === modelId ? 'bg-secondary' : ''}`}
                >
                  <View className="flex-1">
                    <Text className="font-medium text-foreground">{model.name}</Text>
                    <Text className="mt-1 text-xs text-muted-foreground">
                      {model.providerName}{model.groupName ? ` · ${model.groupName}` : ''}
                    </Text>
                  </View>
                  <View className={`h-5 w-5 items-center justify-center rounded-full border ${model.id === modelId ? 'border-primary bg-primary' : 'border-border'}`}>
                    {model.id === modelId ? <Send color="#161719" size={11} /> : null}
                  </View>
                </Pressable>
              ))}
            </Card>
          </View>

          {error ? <Text className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</Text> : null}
        </ScrollView>
        <View
          className="border-t border-border bg-background px-4 pt-3"
          style={{ flexShrink: 0, paddingBottom: Math.max(insets.bottom + 8, 8) }}
        >
          <Button
            onPress={() => void submit()}
            disabled={!canDelegate}
            size="lg"
            className="rounded-xl"
          >
            {busy ? <ActivityIndicator color="#161719" /> : <Send color="#161719" size={17} />}
            <Text>Delegate task</Text>
          </Button>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
