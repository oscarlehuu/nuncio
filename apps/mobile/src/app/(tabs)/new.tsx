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
import { Bot, Send, Sparkles } from 'lucide-react-native';
import { createSession, fetchModels } from '@nuncio/core/api';
import { createCrewTask } from '@nuncio/core/crew-api';
import {
  flattenProviders,
  pickDefaultModelSelection,
  type FlatModel,
  type ModelProvider,
} from '@nuncio/core/model-providers';
import { CrewComposerOptions } from '../../components/crew-composer-options';
import { CrewModePicker } from '../../components/crew-mode-picker';
import {
  buildCrewTaskInput,
  buildSoloCreateArgs,
  createCrewSubmitLock,
  initialExecutionMode,
} from '../../lib/crew-composer';
import { useCrewComposerState } from '../../lib/crew-composer-state';
import { crewTaskPath } from '../../lib/crew-navigation';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Text } from '../../components/ui/text';
import { Textarea } from '../../components/ui/textarea';

export default function NewSession() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState(initialExecutionMode);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [promptHeight, setPromptHeight] = useState(144);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitLock = useRef(createCrewSubmitLock());
  const crew = useCrewComposerState(mode);

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
  const canDelegate = Boolean(
    prompt.trim() && !busy && (mode === 'solo' ? selected : crew.canSubmit),
  );

  const submit = async () => {
    if (!canDelegate || !submitLock.current.tryAcquire()) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'solo') {
        const session = await createSession(...buildSoloCreateArgs(prompt, selected));
        router.replace(`/session/${session.id}`);
      } else {
        const input = buildCrewTaskInput({
          objective: prompt,
          projectPath: crew.projectPath,
          profileId: crew.profileId,
          baseBranch: crew.baseBranch,
        });
        if (!input) return;
        const { task } = await createCrewTask(input);
        router.replace(crewTaskPath(task.id));
      }
    } catch {
      setError(mode === 'solo' ? 'Could not create the session.' : 'Could not create the Crew task.');
    } finally {
      submitLock.current.release();
      setBusy(false);
    }
  };

  const openCrewSettings = () => {
    router.push('/settings');
  };

  return (
    <SafeAreaView className="flex-1 bg-background" style={{ flex: 1 }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
        className="flex-1"
        style={{ flex: 1 }}
      >
        <View className="px-4 pb-3">
          <Text className="text-3xl font-semibold tracking-tight text-foreground">New task</Text>
          <Text className="mt-2 text-sm text-muted-foreground">
            Delegate work to a Solo agent or a Crew workflow.
          </Text>
        </View>

        <ScrollView
          className="flex-1 px-4"
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          <Card className="gap-0 rounded-2xl border-border/70 p-4 shadow-none">
            <View className="mb-3 flex-row items-center gap-2">
              {mode === 'solo' ? <Bot color="#208aef" size={17} /> : <Sparkles color="#208aef" size={17} />}
              <Text className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                {mode === 'solo' ? 'Solo agent' : 'Crew workflow'}
              </Text>
            </View>
            <Textarea
            className="min-h-36 border-0 bg-transparent px-0 py-0 text-base leading-6 shadow-none"
            style={{ height: promptHeight }}
            placeholder={mode === 'solo' ? 'What should the agent work on?' : 'What should the Crew deliver?'}
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

          <CrewModePicker value={mode} disabled={busy} onChange={setMode} />

          {mode === 'solo' ? (
            <View className="mt-5">
              <View className="mb-2 flex-row items-center justify-between">
                <Text className="text-sm font-medium text-foreground">Agent model</Text>
                <Text className="text-xs text-muted-foreground">Choose a provider</Text>
              </View>
              <Card className="gap-0 overflow-hidden rounded-2xl border-border/70 p-1 shadow-none">
                {models.map((model) => (
                  <Pressable
                    key={`${model.providerId}:${model.id}`}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: model.id === modelId }}
                    onPress={() => setModelId(model.id)}
                    className={`min-h-14 flex-row items-center justify-between rounded-xl border-b border-border/50 px-3 py-2 ${model.id === modelId ? 'bg-secondary' : ''}`}
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
          ) : (
            <CrewComposerOptions
              profiles={crew.profiles}
              projects={crew.projects}
              branches={crew.branches}
              profileId={crew.profileId}
              projectPath={crew.projectPath}
              baseBranch={crew.baseBranch}
              resolution={crew.resolution}
              loading={crew.optionsLoading}
              resolving={crew.resolving}
              error={crew.error}
              onProfileChange={crew.setProfileId}
              onProjectChange={crew.setProjectPath}
              onBranchChange={crew.setBaseBranch}
              onRetry={crew.retry}
              onOpenSetup={openCrewSettings}
            />
          )}

          {error ? <Text className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</Text> : null}
        </ScrollView>
        <View
          className="border-t border-border/60 bg-background px-4 pt-3"
          style={{ flexShrink: 0, paddingBottom: Math.max(insets.bottom + 8, 8) }}
        >
          <Button
            onPress={() => void submit()}
            disabled={!canDelegate}
            size="lg"
            className="rounded-xl"
          >
            {busy ? <ActivityIndicator color="#161719" /> : <Send color="#161719" size={17} />}
            <Text>{mode === 'solo' ? 'Delegate task' : 'Start Crew run'}</Text>
          </Button>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
