import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import { ChevronRight, Folder, Send, Settings2 } from 'lucide-react-native';
import { createSession, fetchModels, type Session } from '@nuncio/core/api';
import {
  flattenProviders,
  normalizeModelCatalog,
  pickDefaultModelSelection,
  type ModelInfo,
  type ModelProvider,
} from '@nuncio/core/model-providers';
import { ProviderIcon, brandForModel, type Brand } from './provider-icon';
import {
  fetchCrewBranches,
  fetchCrewProjects,
  preferredCrewBaseBranch,
  type CrewProject,
} from '../lib/crew-projects';
import { createCrewSubmitLock } from '../lib/crew-composer';
import { basename } from '../lib/home-sections';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Text } from './ui/text';
import { Textarea } from './ui/textarea';

type SheetMode = 'model' | 'project' | null;

interface HomeComposerProps {
  onCreated: (session: Session) => void;
  onAdvanced: () => void;
}

export function HomeComposer({ onCreated, onAdvanced }: HomeComposerProps) {
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);
  const submitLock = useRef(createCrewSubmitLock());
  const [prompt, setPrompt] = useState('');
  const [promptHeight, setPromptHeight] = useState(64);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [projects, setProjects] = useState<CrewProject[]>([]);
  const [projectPath, setProjectPath] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [sheetMode, setSheetMode] = useState<SheetMode>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchModels()
      .then((catalog) => {
        setProviders(catalog);
        const preferred = pickDefaultModelSelection(catalog);
        if (preferred) setModelId(preferred.modelId);
      })
      .catch(() => setError('Could not load available models.'));
    void fetchCrewProjects()
      .then(setProjects)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!projectPath) {
      setBaseBranch('');
      return () => {
        cancelled = true;
      };
    }
    void fetchCrewBranches(projectPath)
      .then((branches) => {
        if (!cancelled) setBaseBranch(preferredCrewBaseBranch(branches));
      })
      .catch(() => {
        if (!cancelled) setBaseBranch('');
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const catalog = useMemo(() => normalizeModelCatalog(providers), [providers]);
  const models = useMemo(() => flattenProviders(catalog), [catalog]);
  const selectedModel = models.find((model) => model.id === modelId);
  const selectedProject = projects.find((project) => project.path === projectPath);
  const canSend = Boolean(prompt.trim() && selectedModel && !busy);

  const openSheet = (mode: Exclude<SheetMode, null>) => {
    setSheetMode(mode);
    sheetRef.current?.present();
  };

  const closeSheet = () => {
    sheetRef.current?.dismiss();
    setSheetMode(null);
  };

  const send = async () => {
    if (!canSend || !selectedModel || !submitLock.current.tryAcquire()) return;
    setBusy(true);
    setError(null);
    try {
      const session = await createSession(
        prompt.trim(),
        selectedModel.id,
        selectedModel.providerId,
        projectPath || undefined,
        baseBranch || undefined,
      );
      setPrompt('');
      onCreated(session);
    } catch {
      setError('Could not create the session.');
    } finally {
      submitLock.current.release();
      setBusy(false);
    }
  };

  return (
    <>
      <Card className="mx-4 mb-4 gap-0 rounded-xl border-border p-4 shadow-none">
        <Textarea
          value={prompt}
          onChangeText={setPrompt}
          placeholder="What should Nuncio work on?"
          placeholderTextColor="#83868b"
          className="border-0 bg-transparent px-0 py-0 text-base leading-6 shadow-none"
          style={{ height: promptHeight }}
          onContentSizeChange={(event) => {
            setPromptHeight(Math.min(180, Math.max(64, event.nativeEvent.contentSize.height)));
          }}
        />
        <View className="mt-3 flex-row items-center gap-2">
          <Pressable
            accessibilityLabel="Choose project"
            onPress={() => openSheet('project')}
            className="min-h-10 flex-1 flex-row items-center gap-2 rounded-xl border border-border bg-secondary px-3 active:opacity-70"
          >
            <Folder color="#83868b" size={15} />
            <Text className="flex-1 text-xs font-medium text-foreground" numberOfLines={1}>
              {selectedProject ? basename(selectedProject.path) : 'Default workspace'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Choose model"
            onPress={() => openSheet('model')}
            className="min-h-10 flex-1 flex-row items-center gap-2 rounded-xl border border-border bg-secondary px-3 active:opacity-70"
          >
            {selectedModel ? (
              <ProviderIcon brand={brandForModel(selectedModel)} size={15} color="#c8cace" />
            ) : (
              <Settings2 color="#83868b" size={15} />
            )}
            <Text className="flex-1 text-xs font-medium text-foreground" numberOfLines={1}>
              {selectedModel?.name ?? 'Choose model'}
            </Text>
          </Pressable>
        </View>
        <View className="mt-3 flex-row items-center justify-between">
          <Pressable
            accessibilityLabel="Switch to Crew or advanced options"
            onPress={onAdvanced}
            className="min-h-11 flex-row items-center gap-1 py-1 active:opacity-70"
          >
            <Text className="text-xs font-medium text-muted-foreground">Crew / advanced</Text>
            <ChevronRight color="#83868b" size={13} />
          </Pressable>
          <Button
            accessibilityLabel="Send task"
            onPress={() => void send()}
            disabled={!canSend}
            size="icon"
            className="h-11 w-11 rounded-full"
          >
            {busy ? <ActivityIndicator size="small" color="#161719" /> : <Send color="#161719" size={17} />}
          </Button>
        </View>
        {error ? <Text className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</Text> : null}
      </Card>

      <BottomSheetModal
        ref={sheetRef}
        index={0}
        snapPoints={['70%']}
        topInset={insets.top}
        enableDynamicSizing={false}
        enablePanDownToClose
        backdropComponent={(props) => (
          <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} />
        )}
        backgroundStyle={{ backgroundColor: '#18191c' }}
        handleIndicatorStyle={{ backgroundColor: '#606369' }}
        onDismiss={() => setSheetMode(null)}
      >
        <BottomSheetView className="flex-1 px-5 pt-1">
          <Text className="text-lg font-semibold text-foreground">
            {sheetMode === 'project' ? 'Choose a project' : 'Choose a model'}
          </Text>
          <Text className="mt-1 text-xs text-muted-foreground">
            {sheetMode === 'project'
              ? 'The project determines the workspace and base branch.'
              : 'Grouped by engine — pick which model handles this task.'}
          </Text>
          <BottomSheetScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{
              paddingBottom: insets.bottom + 16,
              paddingTop: 14,
            }}
            showsVerticalScrollIndicator={false}
          >
            {sheetMode === 'project' ? (
              <View className="gap-2">
                <PickerRow
                  label="Default workspace"
                  detail="Agent runs in its own scratch space"
                  selected={!projectPath}
                  onPress={() => {
                    setProjectPath('');
                    closeSheet();
                  }}
                />
                {projects.map((project) => (
                  <PickerRow
                    key={project.path}
                    label={basename(project.path)}
                    detail={project.path}
                    selected={project.path === projectPath}
                    onPress={() => {
                      setProjectPath(project.path);
                      closeSheet();
                    }}
                  />
                ))}
                {projects.length === 0 ? (
                  <Text className="mt-1 px-1 text-xs leading-5 text-muted-foreground">
                    No Git projects registered yet. Add a project root in the Nuncio desktop app to pick a repo and base branch here.
                  </Text>
                ) : null}
              </View>
            ) : (
              <View className="gap-5">
                {catalog
                  .filter((provider) => !provider.unavailable && provider.groups?.length)
                  .flatMap((provider) =>
                    (provider.groups ?? []).map((group) => (
                      <View key={`${provider.id}:${group.id}`} className="gap-1.5">
                        <View className="flex-row items-center gap-2 px-1">
                          <ProviderIcon
                            brand={brandForModel({ providerId: provider.id, groupId: group.id, id: group.id, name: group.name })}
                            size={13}
                            color="#83868b"
                          />
                          <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground" numberOfLines={1}>
                            {group.name}
                          </Text>
                        </View>
                        <View className="gap-1.5">
                          {group.models.map((model) => (
                            <ModelRow
                              key={`${provider.id}:${group.id}:${model.id}`}
                              model={model}
                              brand={brandForModel({ providerId: provider.id, groupId: group.id, id: model.id, name: model.name })}
                              selected={model.id === modelId}
                              onPress={() => {
                                setModelId(model.id);
                                closeSheet();
                              }}
                            />
                          ))}
                        </View>
                      </View>
                    )),
                  )}
              </View>
            )}
          </BottomSheetScrollView>
        </BottomSheetView>
      </BottomSheetModal>
    </>
  );
}

function PickerRow({
  label,
  detail,
  selected,
  onPress,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={`min-h-14 flex-row items-center justify-between rounded-xl border border-border px-3 py-2 ${selected ? 'bg-secondary' : 'bg-card'}`}
    >
      <View className="min-w-0 flex-1">
        <Text className="font-medium text-foreground" numberOfLines={1}>{label}</Text>
        {detail ? <Text className="mt-1 text-xs text-muted-foreground" numberOfLines={1}>{detail}</Text> : null}
      </View>
      {selected ? <View className="h-2.5 w-2.5 rounded-full bg-primary" /> : null}
    </Pressable>
  );
}

function ModelRow({
  model,
  brand,
  selected,
  onPress,
}: {
  model: ModelInfo;
  brand: Brand;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={`min-h-12 flex-row items-center gap-3 rounded-xl border px-3 py-2 ${selected ? 'border-primary/40 bg-secondary' : 'border-border bg-card'}`}
    >
      <View className="h-7 w-7 items-center justify-center rounded-lg bg-background">
        <ProviderIcon brand={brand} size={15} color={selected ? '#eff0f1' : '#9ca3af'} />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>{model.name}</Text>
        {model.sub ? (
          <Text className="mt-0.5 text-[11px] text-muted-foreground" numberOfLines={1}>{model.sub}</Text>
        ) : null}
      </View>
      {model.badge ? (
        <Text className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {model.badge}
        </Text>
      ) : null}
      {selected ? <View className="ml-1 h-2 w-2 rounded-full bg-primary" /> : null}
    </Pressable>
  );
}
