import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { createSession, fetchModels } from '@nuncio/core/api';
import { createCrewTask } from '@nuncio/core/crew-api';
import {
  flattenProviders,
  pickDefaultModelSelection,
  type FlatModel,
  type ModelProvider,
} from '@nuncio/core/model-providers';
import { CrewComposerOptions } from '../components/crew-composer-options';
import { CrewModePicker } from '../components/crew-mode-picker';
import { activeConnection } from '../lib/api-setup';
import {
  buildCrewTaskInput,
  buildSoloCreateArgs,
  createCrewSubmitLock,
  crewProfileSettingsUrl,
  initialExecutionMode,
} from '../lib/crew-composer';
import { useCrewComposerState } from '../lib/crew-composer-state';
import { crewTaskPath } from '../lib/crew-navigation';

export default function NewSession() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState(initialExecutionMode);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
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
    const baseUrl = activeConnection()?.serverUrl;
    if (!baseUrl) {
      setError('Pair with your Nuncio machine before opening web settings.');
      return;
    }
    void Linking.openURL(crewProfileSettingsUrl(baseUrl)).catch(() => {
      setError('Could not open Crew profile settings.');
    });
  };

  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1">
        <View className="flex-row items-center justify-between px-4 pb-3">
          <Text className="text-2xl font-semibold text-foreground">New task</Text>
          <Pressable onPress={() => router.back()} className="min-h-11 justify-center px-2">
            <Text className="text-muted-foreground">Cancel</Text>
          </Pressable>
        </View>

        <ScrollView className="flex-1 px-4" contentContainerClassName="pb-8" keyboardShouldPersistTaps="handled">
          <TextInput
            className="min-h-32 rounded-lg border border-border px-4 py-3 text-foreground"
            placeholder={mode === 'solo' ? 'What should the agent work on?' : 'What should the Crew deliver?'}
            placeholderTextColor="#6b7280"
            multiline
            value={prompt}
            onChangeText={setPrompt}
          />

          <CrewModePicker value={mode} disabled={busy} onChange={setMode} />

          {mode === 'solo' ? (
            <View className="mt-5">
              <Text className="mb-2 text-sm text-muted-foreground">Model</Text>
              <View className="overflow-hidden rounded-lg border border-border">
                {models.map((model) => (
                  <Pressable
                    key={`${model.providerId}:${model.id}`}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: model.id === modelId }}
                    onPress={() => setModelId(model.id)}
                    className={`min-h-11 border-b border-border px-4 py-3 ${model.id === modelId ? 'bg-secondary' : ''}`}
                  >
                    <Text className="text-foreground">{model.name}</Text>
                    <Text className="text-xs text-muted-foreground">
                      {model.providerName}{model.groupName ? ` · ${model.groupName}` : ''}
                    </Text>
                  </Pressable>
                ))}
              </View>
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

          {error ? <Text className="mt-4 text-sm text-destructive">{error}</Text> : null}
          <Pressable
            onPress={() => void submit()}
            disabled={!canDelegate}
            className={`mt-6 min-h-11 items-center justify-center rounded-lg px-4 ${canDelegate ? 'bg-primary' : 'bg-muted'}`}
          >
            {busy ? <ActivityIndicator /> : (
              <Text className="font-semibold text-primary-foreground">
                {mode === 'solo' ? 'Delegate to Solo' : 'Delegate to Crew'}
              </Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
