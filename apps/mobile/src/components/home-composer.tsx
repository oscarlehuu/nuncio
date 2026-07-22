import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  BottomSheetModal,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';
import { ArrowUp, Check, ChevronRight, Folder, FolderSearch, GitBranch, Laptop, Send, Settings2, SlidersHorizontal } from 'lucide-react-native';
import { createSession, fetchModels, type Session } from '@nuncio/core/api';
import {
  flattenProviders,
  normalizeModelCatalog,
  pickDefaultModelSelection,
  type ModelInfo,
  type ModelProvider,
} from '@nuncio/core/model-providers';
import {
  defaultSelectionsFromDescriptors,
  optionSummaryLabel,
  type ModelOptionDescriptor,
  type ModelOptionsMap,
} from '@nuncio/core/model-options';
import { ProviderIcon, brandForModel, type Brand } from './provider-icon';
import {
  fetchBranches,
  fetchProjects,
  preferredBaseBranch,
  selectableBranches,
  type Branch,
  type Project,
} from '../lib/projects';
import { createSubmitLock } from '../lib/submit-lock';
import { fetchDirectories, type DirListing } from '../lib/fs-api';
import { basename } from '../lib/home-sections';
import { composerModelOptionDescriptors } from '../lib/model-option-descriptors';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Text } from './ui/text';
import { Textarea } from './ui/textarea';

type SheetMode = 'model' | 'options' | 'project' | 'browse' | 'workspace' | 'branch' | null;
type WorkspaceMode = 'local' | 'worktree';
type Engine = {
  key: string;
  label: string;
  brand: Brand;
  models: ModelInfo[];
};
type ModelListItem =
  | { type: 'header'; key: string; label: string }
  | { type: 'model'; key: string; model: ModelInfo; groupId: string };

const SHEET_COPY: Record<Exclude<SheetMode, null>, { title: string; subtitle: string }> = {
  model: { title: 'Choose a model', subtitle: 'Pick an engine, then a model.' },
  options: { title: 'Model options', subtitle: 'Tune reasoning effort and priority for this model.' },
  project: { title: 'Choose a project', subtitle: 'The project determines the workspace and base branch.' },
  browse: { title: 'Browse folders', subtitle: 'Navigate the machine and pick a project folder.' },
  workspace: { title: 'Workspace mode', subtitle: 'Run in the repo checkout, or fork an isolated worktree.' },
  branch: { title: 'Base branch', subtitle: 'The worktree forks from this branch.' },
};

interface HomeComposerProps {
  onCreated: (session: Session) => void;
  onAdvanced: () => void;
}

export function HomeComposer({ onCreated, onAdvanced }: HomeComposerProps) {
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);
  const submitLock = useRef(createSubmitLock());
  const [prompt, setPrompt] = useState('');
  const [promptHeight, setPromptHeight] = useState(64);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectPath, setProjectPath] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const branchReqId = useRef(0);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('local');
  const [sheetMode, setSheetMode] = useState<SheetMode>(null);
  const [modelEngineKey, setModelEngineKey] = useState<string | null>(null);
  const [browseListing, setBrowseListing] = useState<DirListing | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOptionsMap>({});
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
    void fetchProjects()
      .then(setProjects)
      .catch(() => {});
  }, []);

  const loadBranches = useCallback(async (path: string) => {
    const reqId = ++branchReqId.current;
    setBranchesLoading(true);
    setBranchesError(null);
    try {
      const list = await fetchBranches(path);
      if (reqId !== branchReqId.current) return;
      setBranches(list);
      setBaseBranch(preferredBaseBranch(list));
    } catch {
      if (reqId !== branchReqId.current) return;
      setBranches([]);
      setBaseBranch('');
      setBranchesError('Could not load branches — check the connection, then retry.');
    } finally {
      if (reqId === branchReqId.current) setBranchesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!projectPath) {
      branchReqId.current++;
      setBaseBranch('');
      setBranches([]);
      setBranchesError(null);
      setBranchesLoading(false);
      setWorkspaceMode('local');
      return;
    }
    void loadBranches(projectPath);
  }, [projectPath, loadBranches]);

  const catalog = useMemo(() => normalizeModelCatalog(providers), [providers]);
  const models = useMemo(() => flattenProviders(catalog), [catalog]);
  const selectedModel = models.find((model) => model.id === modelId);

  // Reset the per-model option selections (reasoning effort, priority, …) to
  // their defaults whenever the chosen model changes.
  useEffect(() => {
    const model = models.find((entry) => entry.id === modelId);
    setModelOptions(defaultSelectionsFromDescriptors(model?.options));
  }, [modelId, models]);
  const selectableBranchList = useMemo(() => selectableBranches(branches), [branches]);
  const sheetCopy = sheetMode ? SHEET_COPY[sheetMode] : null;
  const modelOptionDescriptors = useMemo<ModelOptionDescriptor[]>(
    () => composerModelOptionDescriptors(selectedModel),
    [selectedModel],
  );
  const optionsSummary = optionSummaryLabel(modelOptionDescriptors, modelOptions);
  const canSend = Boolean(prompt.trim() && selectedModel && !busy);

  // Engines = providers (Claude / Cursor / Codex / Nuncio Engine …); each
  // provider's groups (cliproxy, xai, oauth …) become sub-headers inside it.
  const engines = useMemo<Engine[]>(
    () =>
      catalog
        .filter((provider) => !provider.unavailable && provider.groups?.length)
        .map((provider) => ({
          key: provider.id,
          label: provider.name,
          brand: brandForModel({ providerId: provider.id, groupId: '', id: provider.id, name: provider.name }),
          models: flattenProviders([provider]),
        })),
    [catalog],
  );
  const selectedProviderId = selectedModel?.providerId ?? null;
  const activeEngineKey = modelEngineKey ?? selectedProviderId ?? engines[0]?.key ?? null;
  const activeProvider = catalog.find((provider) => provider.id === activeEngineKey) ?? null;
  const modelItems = useMemo<ModelListItem[]>(() => {
    if (!activeProvider) return [];
    const groups = (activeProvider.groups ?? []).filter((group) => group.models.length > 0);
    const showHeaders = groups.length > 1;
    const items: ModelListItem[] = [];
    for (const group of groups) {
      if (showHeaders) {
        items.push({ type: 'header', key: `h:${activeProvider.id}:${group.id}`, label: group.name });
      }
      for (const model of group.models) {
        items.push({ type: 'model', key: `${activeProvider.id}:${group.id}:${model.id}`, model, groupId: group.id });
      }
    }
    return items;
  }, [activeProvider]);

  const openSheet = (mode: Exclude<SheetMode, null>) => {
    if (mode === 'model') setModelEngineKey(null);
    setSheetMode(mode);
    sheetRef.current?.present();
  };

  const loadDirs = useCallback(async (path?: string) => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      setBrowseListing(await fetchDirectories(path));
    } catch {
      setBrowseError('Could not load folders. Is the machine reachable?');
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  const openBrowse = () => {
    setSheetMode('browse');
    void loadDirs(projectPath || undefined);
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
        Object.keys(modelOptions).length > 0 ? modelOptions : undefined,
        Boolean(projectPath) && workspaceMode === 'worktree',
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
              {projectPath ? basename(projectPath) : 'Default workspace'}
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
        {modelOptionDescriptors.length > 0 ? (
          <Pressable
            accessibilityLabel="Model options"
            onPress={() => openSheet('options')}
            className="mt-2 min-h-10 flex-row items-center gap-2 rounded-xl border border-border bg-secondary px-3 active:opacity-70"
          >
            <SlidersHorizontal color="#83868b" size={15} />
            <Text className="flex-1 text-xs font-medium text-foreground" numberOfLines={1}>
              {optionsSummary ?? 'Model options'}
            </Text>
            <ChevronRight color="#83868b" size={15} />
          </Pressable>
        ) : null}
        {projectPath ? (
          <View className="mt-2 flex-row items-center gap-2">
            <Pressable
              accessibilityLabel="Choose workspace mode"
              onPress={() => openSheet('workspace')}
              className="min-h-10 flex-1 flex-row items-center gap-2 rounded-xl border border-border bg-secondary px-3 active:opacity-70"
            >
              {workspaceMode === 'worktree' ? (
                <GitBranch color="#83868b" size={15} />
              ) : (
                <Laptop color="#83868b" size={15} />
              )}
              <Text className="flex-1 text-xs font-medium text-foreground" numberOfLines={1}>
                {workspaceMode === 'worktree' ? 'New worktree' : 'Work locally'}
              </Text>
            </Pressable>
            {workspaceMode === 'worktree' ? (
              <Pressable
                accessibilityLabel="Choose base branch"
                onPress={() => openSheet('branch')}
                className="min-h-10 flex-1 flex-row items-center gap-2 rounded-xl border border-border bg-secondary px-3 active:opacity-70"
              >
                <GitBranch color="#83868b" size={15} />
                <Text className="flex-1 text-xs font-medium text-foreground" numberOfLines={1}>
                  {baseBranch || 'Base branch'}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        <View className="mt-3 flex-row items-center justify-between">
          <Pressable
            accessibilityLabel="Open advanced options"
            onPress={onAdvanced}
            className="min-h-11 flex-row items-center gap-1 py-1 active:opacity-70"
          >
            <Text className="text-xs font-medium text-muted-foreground">Advanced</Text>
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
        {sheetMode === 'model' ? (
          <BottomSheetFlatList
            data={modelItems}
            keyExtractor={(item) => item.key}
            style={{ flex: 1 }}
            contentContainerStyle={{
              paddingHorizontal: 20,
              paddingBottom: insets.bottom + 16,
              gap: 6,
            }}
            showsVerticalScrollIndicator={false}
            ListHeaderComponent={
              <View className="pb-3 pt-1">
                <Text className="text-lg font-semibold text-foreground">Choose a model</Text>
                <Text className="mt-1 text-xs text-muted-foreground">Pick an engine, then a model.</Text>
                {engines.length > 1 ? (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    className="-mx-5 mt-3"
                    contentContainerClassName="gap-2 px-5"
                  >
                    {engines.map((engine) => {
                      const active = engine.key === activeEngineKey;
                      return (
                        <Pressable
                          key={engine.key}
                          accessibilityRole="tab"
                          accessibilityState={{ selected: active }}
                          onPress={() => setModelEngineKey(engine.key)}
                          className={`min-h-9 flex-row items-center gap-1.5 rounded-full border px-3 ${active ? 'border-primary/50 bg-secondary' : 'border-border bg-card'}`}
                        >
                          <ProviderIcon brand={engine.brand} size={13} color={active ? '#eff0f1' : '#83868b'} />
                          <Text
                            className={`text-xs font-medium ${active ? 'text-foreground' : 'text-muted-foreground'}`}
                            numberOfLines={1}
                          >
                            {engine.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                ) : null}
              </View>
            }
            ListEmptyComponent={
              <Text className="px-1 py-8 text-center text-xs text-muted-foreground">Loading models…</Text>
            }
            renderItem={({ item }) =>
              item.type === 'header' ? (
                <Text className="px-1 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {item.label}
                </Text>
              ) : (
                <ModelRow
                  model={item.model}
                  brand={brandForModel({
                    providerId: activeProvider?.id ?? '',
                    groupId: item.groupId,
                    id: item.model.id,
                    name: item.model.name,
                  })}
                  selected={item.model.id === modelId}
                  onPress={() => {
                    setModelId(item.model.id);
                    closeSheet();
                  }}
                />
              )
            }
          />
        ) : (
          <BottomSheetScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{
              paddingHorizontal: 20,
              paddingBottom: insets.bottom + 16,
              paddingTop: 4,
            }}
            showsVerticalScrollIndicator={false}
          >
            <Text className="text-lg font-semibold text-foreground">{sheetCopy?.title}</Text>
            <Text className="mb-3 mt-1 text-xs text-muted-foreground">{sheetCopy?.subtitle}</Text>
            {sheetMode === 'options' ? (
              <View className="gap-5">
                {modelOptionDescriptors.map((descriptor) => (
                  <View key={descriptor.id} className="gap-2">
                    <Text className="text-sm font-medium text-foreground">{descriptor.label}</Text>
                    {descriptor.type === 'boolean' ? (
                      <View className="flex-row gap-2">
                        {[{ value: false, label: 'Off' }, { value: true, label: 'On' }].map((choice) => {
                          const active = (modelOptions[descriptor.id] ?? descriptor.defaultValue ?? false) === choice.value;
                          return (
                            <Pressable
                              key={choice.label}
                              onPress={() => setModelOptions((prev) => ({ ...prev, [descriptor.id]: choice.value }))}
                              className={`min-h-11 flex-1 items-center justify-center rounded-xl border ${active ? 'border-primary/50 bg-secondary' : 'border-border bg-card'}`}
                            >
                              <Text className={active ? 'text-sm font-medium text-foreground' : 'text-sm text-muted-foreground'}>
                                {choice.label}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    ) : (
                      <View className="flex-row flex-wrap gap-2">
                        {(descriptor.options ?? []).map((choice) => {
                          const active = modelOptions[descriptor.id] === choice.id;
                          return (
                            <Pressable
                              key={choice.id}
                              onPress={() => setModelOptions((prev) => ({ ...prev, [descriptor.id]: choice.id }))}
                              className={`min-h-11 flex-row items-center gap-1.5 rounded-xl border px-3 ${active ? 'border-primary/50 bg-secondary' : 'border-border bg-card'}`}
                            >
                              {active ? <Check color="#eff0f1" size={14} /> : null}
                              <Text className={active ? 'text-sm font-medium text-foreground' : 'text-sm text-muted-foreground'}>
                                {choice.label}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    )}
                  </View>
                ))}
                {modelOptionDescriptors.length === 0 ? (
                  <Text className="px-1 text-xs text-muted-foreground">This model has no adjustable options.</Text>
                ) : null}
              </View>
            ) : sheetMode === 'project' ? (
              <View className="gap-2">
                <Pressable
                  accessibilityLabel="Browse folders"
                  onPress={openBrowse}
                  className="min-h-14 flex-row items-center gap-3 rounded-xl border border-dashed border-input px-3 active:opacity-70"
                >
                  <FolderSearch color="#83868b" size={18} />
                  <View className="min-w-0 flex-1">
                    <Text className="font-medium text-foreground">Browse folders…</Text>
                    <Text className="mt-1 text-xs text-muted-foreground">Pick any git repo on the machine</Text>
                  </View>
                  <ChevronRight color="#83868b" size={16} />
                </Pressable>
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
                    No projects registered under “Project roots”. Use “Browse folders” above to pick any git repo on the machine.
                  </Text>
                ) : null}
              </View>
            ) : sheetMode === 'browse' ? (
              <View className="gap-2">
                <View className="flex-row items-center gap-2">
                  {browseListing?.parent != null ? (
                    <Pressable
                      accessibilityLabel="Parent folder"
                      onPress={() => {
                        const parent = browseListing?.parent;
                        if (parent) void loadDirs(parent);
                      }}
                      className="min-h-9 flex-row items-center gap-1 rounded-lg border border-border bg-card px-2.5 active:opacity-70"
                    >
                      <ArrowUp color="#83868b" size={14} />
                      <Text className="text-xs text-muted-foreground">Up</Text>
                    </Pressable>
                  ) : null}
                  <Text className="min-w-0 flex-1 font-mono text-[11px] text-muted-foreground" numberOfLines={1}>
                    {browseListing?.current ?? '…'}
                  </Text>
                </View>
                <Pressable
                  accessibilityLabel="Use this folder"
                  disabled={!browseListing || browseLoading}
                  onPress={() => {
                    if (browseListing) {
                      setProjectPath(browseListing.current);
                      closeSheet();
                    }
                  }}
                  className={`min-h-11 flex-row items-center justify-center rounded-xl bg-primary px-3 active:opacity-90 ${!browseListing || browseLoading ? 'opacity-50' : ''}`}
                >
                  <Text className="text-sm font-semibold text-primary-foreground">Use this folder</Text>
                </Pressable>
                {browseLoading ? (
                  <ActivityIndicator className="mt-4" />
                ) : browseError ? (
                  <Text className="mt-2 px-1 text-xs text-destructive">{browseError}</Text>
                ) : browseListing && browseListing.entries.length === 0 ? (
                  <Text className="mt-2 px-1 text-xs text-muted-foreground">No subfolders here.</Text>
                ) : (
                  (browseListing?.entries ?? []).map((entry) => (
                    <Pressable
                      key={entry.path}
                      onPress={() => void loadDirs(entry.path)}
                      className="min-h-12 flex-row items-center gap-3 rounded-xl border border-border bg-card px-3 py-2 active:opacity-70"
                    >
                      <Folder color="#83868b" size={16} />
                      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>{entry.name}</Text>
                      {entry.isGit ? (
                        <View className="flex-row items-center gap-1 rounded-md bg-muted px-1.5 py-0.5">
                          <GitBranch color="#83868b" size={11} />
                          <Text className="text-[10px] text-muted-foreground">git</Text>
                        </View>
                      ) : null}
                      <ChevronRight color="#606369" size={15} />
                    </Pressable>
                  ))
                )}
              </View>
            ) : sheetMode === 'workspace' ? (
              <View className="gap-2">
                <PickerRow
                  label="Work locally"
                  detail="Run in the selected repo checkout"
                  selected={workspaceMode === 'local'}
                  onPress={() => {
                    setWorkspaceMode('local');
                    closeSheet();
                  }}
                />
                <PickerRow
                  label="New worktree"
                  detail="Fork an isolated worktree from the base branch"
                  selected={workspaceMode === 'worktree'}
                  onPress={() => {
                    setWorkspaceMode('worktree');
                    closeSheet();
                  }}
                />
              </View>
            ) : sheetMode === 'branch' ? (
              <View className="gap-2">
                {branchesLoading ? (
                  <ActivityIndicator className="mt-6" accessibilityLabel="Loading branches" />
                ) : branchesError ? (
                  <Pressable
                    accessibilityLabel="Retry loading branches"
                    onPress={() => void loadBranches(projectPath)}
                    className="mt-2 min-h-11 items-center justify-center rounded-xl border border-border bg-card px-3 py-2 active:opacity-70"
                  >
                    <Text className="text-center text-xs leading-5 text-muted-foreground">{branchesError}</Text>
                  </Pressable>
                ) : selectableBranchList.length ? (
                  selectableBranchList.map((branch) => (
                    <PickerRow
                      key={branch.name}
                      label={branch.name}
                      detail={branch.isDefault ? 'Default branch' : branch.isCurrent ? 'Current branch' : undefined}
                      selected={branch.name === baseBranch}
                      onPress={() => {
                        setBaseBranch(branch.name);
                        closeSheet();
                      }}
                    />
                  ))
                ) : (
                  <Text className="mt-1 px-1 text-xs leading-5 text-muted-foreground">
                    No selectable branches — this repo only has Nuncio session branches. Pick another project.
                  </Text>
                )}
              </View>
            ) : null}
          </BottomSheetScrollView>
        )}
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
