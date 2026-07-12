import { useEffect, useMemo, useState } from 'react';
import { CornerDownLeft, Plus, Link2, Server, Check } from 'lucide-react';
import { toast } from 'sonner';
import type { MessageAttachment, Session } from '../lib/api';
import { createSession, fetchModels, fetchSessions, relativeTime, statusLabel } from '../lib/api';
import { useComposerAttachments } from '../lib/use-composer-attachments';
import { AttachButton, AttachmentTray } from './attachment-tray';
import { currentMachine, fetchHubMachines, machineApiBase, type HubMachine } from '../lib/hub-api';
import {
  modelById,
  modelSupportsImages,
  normalizeModelCatalog,
  pickDefaultModelSelection,
  prettyModelName,
  type ModelProvider,
} from '../lib/model-providers';
import { defaultOptionsForModel } from '../lib/model-picker-catalog';
import { loadModelPreference, resolveModelSelection } from '../lib/model-preference';
import {
  isNuncioSessionBranch,
  loadProjectPreference,
  recordBranchSelection,
  recordProjectSelection,
  resolveWorkspacePreference,
} from '../lib/project-preference';
import { projectDisplayName } from '../lib/projects';
import type { ModelOptionsMap } from '../lib/model-options';
import { ProjectPicker } from './project-picker';
import { BranchPicker } from './branch-picker';
import { WorkspaceModePicker, type WorkspaceMode } from './workspace-mode-picker';
import { ModelPicker } from './model-picker';
import { ProviderIcon } from './provider-icon';
import { StatusDot } from './status-dot';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

type Mode = 'new' | 'attach';

interface GridSlotComposerProps {
  providers: ModelProvider[];
  /** Non-archived sessions available to attach. */
  sessions: Session[];
  /** Session ids already bound to other slots — offered but marked, never blocked. */
  boundSessionIds: Set<string>;
  onCreate: (
    prompt: string,
    model?: string,
    provider?: string,
    projectPath?: string,
    baseBranch?: string,
    modelOptions?: ModelOptionsMap,
    useWorktree?: boolean,
    attachments?: MessageAttachment[],
  ) => Promise<Session | null>;
  /** Bind the slot; machineId is set when the session lives on another hub machine. */
  onBind: (sessionId: string, machineId?: string) => void;
}

export function GridSlotComposer({
  providers,
  sessions,
  boundSessionIds,
  onCreate,
  onBind,
}: GridSlotComposerProps) {
  const [mode, setMode] = useState<Mode>('new');
  const [prompt, setPrompt] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const imageAttachments = useComposerAttachments(setPrompt);
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState<string | undefined>();
  const [modelOptions, setModelOptions] = useState<ModelOptionsMap>({});
  const [projectPath, setProjectPath] = useState<string | undefined>(
    () => resolveWorkspacePreference().projectPath,
  );
  const [baseBranch, setBaseBranch] = useState<string | undefined>(
    () => resolveWorkspacePreference().baseBranch,
  );
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('local');
  const useWorktree = workspaceMode === 'worktree';
  const [submitting, setSubmitting] = useState(false);

  // Hub mode: a slot can target any tailnet machine. null = the machine this
  // page already talks to (single-machine installs never see the picker).
  const [machines, setMachines] = useState<HubMachine[] | null>(null);
  const [machine, setMachine] = useState<string | null>(null);
  const [remoteProviders, setRemoteProviders] = useState<ModelProvider[] | null>(null);
  const [remoteSessions, setRemoteSessions] = useState<Session[] | null>(null);
  const remoteBase = machineApiBase(machine);
  const localName = currentMachine() ?? machines?.find((m) => m.self)?.name ?? null;

  useEffect(() => {
    let cancelled = false;
    fetchHubMachines()
      .then((res) => {
        if (!cancelled) setMachines(res.hubMode ? res.machines : []);
      })
      .catch(() => {
        if (!cancelled) setMachines([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectMachine = (next: string | null) => {
    if (next === machine) return;
    setMachine(next);
    // Machine-scoped inputs reset: paths and model catalogs are per-machine.
    setProjectPath(next ? undefined : resolveWorkspacePreference().projectPath);
    setBaseBranch(next ? undefined : resolveWorkspacePreference().baseBranch);
    setWorkspaceMode('local');
    setModel('');
    setProvider(undefined);
    setModelOptions({});
    setRemoteProviders(null);
    setRemoteSessions(null);
  };

  useEffect(() => {
    if (!machine || !remoteBase) return;
    let cancelled = false;
    fetchModels(remoteBase)
      .then((list) => {
        if (!cancelled) setRemoteProviders(list);
      })
      .catch(() => {
        if (!cancelled) setRemoteProviders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [machine, remoteBase]);

  useEffect(() => {
    if (!machine || !remoteBase || mode !== 'attach') return;
    let cancelled = false;
    fetchSessions(remoteBase)
      .then((list) => {
        if (!cancelled) setRemoteSessions(list);
      })
      .catch(() => {
        if (!cancelled) setRemoteSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [machine, remoteBase, mode]);

  const activeProviders = machine ? (remoteProviders ?? []) : providers;

  const catalog = useMemo(() => normalizeModelCatalog(activeProviders), [activeProviders]);
  const canAttachImages = useMemo(
    () => modelSupportsImages(catalog, provider, model),
    [provider, model, catalog],
  );
  const catalogLoaded = activeProviders.length > 0;

  useEffect(() => {
    if (!catalogLoaded) return;
    const lookup = modelById(catalog);
    if (model && provider && lookup[model]) return;
    const resolved = resolveModelSelection(activeProviders, loadModelPreference());
    if (resolved) {
      if (!modelSupportsImages(catalog, resolved.providerId, resolved.modelId)) {
        imageAttachments.clearWithTokens();
      }
      setModel(resolved.modelId);
      setProvider(resolved.providerId);
      setModelOptions(resolved.modelOptions);
      return;
    }
    const picked = pickDefaultModelSelection(activeProviders);
    if (picked) {
      if (!modelSupportsImages(catalog, picked.providerId, picked.modelId)) {
        imageAttachments.clearWithTokens();
      }
      setModel(picked.modelId);
      setProvider(picked.providerId);
      setModelOptions(defaultOptionsForModel(lookup[picked.modelId]));
    }
  }, [catalogLoaded, activeProviders, catalog, model, provider]);

  const attachable = useMemo(() => {
    const source = machine ? (remoteSessions ?? []) : sessions;
    return source.filter((s) => s.status !== 'ARCHIVED');
  }, [machine, remoteSessions, sessions]);

  const handleProjectChange = (path: string) => {
    setProjectPath(path);
    const savedBranch = loadProjectPreference().lastBranchByProject?.[path];
    setBaseBranch(isNuncioSessionBranch(savedBranch) ? undefined : savedBranch);
    // Preferences are local-machine only; remote projects manage their own branch.
    if (!machine) recordProjectSelection(path, projectDisplayName(path) ?? undefined);
  };

  const handleBranchChange = (branch: string) => {
    setBaseBranch(branch);
    if (!machine && projectPath) recordBranchSelection(projectPath, branch);
  };

  const submit = async () => {
    const text = prompt.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    const attachments = canAttachImages ? imageAttachments.attachments : [];
    const attachmentsArg = attachments.length > 0 ? attachments : undefined;
    try {
      const selected = modelById(catalog)[model];
      const hasConfigurable =
        (selected?.options?.length ?? 0) > 0 || (selected?.variants?.length ?? 0) > 0;
      if (machine && remoteBase) {
        try {
          const created = await createSession(
            text,
            model || undefined,
            provider,
            projectPath,
            baseBranch,
            hasConfigurable ? modelOptions : undefined,
            useWorktree,
            remoteBase,
            attachmentsArg,
          );
          onBind(created.id, machine);
          setPrompt('');
          setWorkspaceMode('local');
          imageAttachments.clear();
        } catch {
          toast.error(`Failed to create session on ${machine}`);
        }
      } else {
        const created = await onCreate(
          text,
          model || undefined,
          provider,
          projectPath,
          baseBranch,
          hasConfigurable ? modelOptions : undefined,
          useWorktree,
          attachmentsArg,
        );
        if (created) {
          setPrompt('');
          setWorkspaceMode('local');
          imageAttachments.clear();
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card/40 text-card-foreground">
      <div
        role="tablist"
        aria-label="New or attach session"
        className="grid grid-cols-2 gap-1 border-b border-border/60 p-1.5"
      >
        <TabButton active={mode === 'new'} onClick={() => setMode('new')} icon={<Plus className="size-3.5" />}>
          New
        </TabButton>
        <TabButton active={mode === 'attach'} onClick={() => setMode('attach')} icon={<Link2 className="size-3.5" />}>
          Attach
        </TabButton>
      </div>

      {machines && machines.length > 0 ? (
        <div className="flex items-center border-b border-border/60 px-1.5 py-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1.5 px-1.5 text-[11.5px] text-muted-foreground"
                aria-label="Choose machine"
              >
                <Server className="size-3" />
                {machine ?? localName ?? 'This machine'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {machines.map((m) => {
                const isLocal = m.name === localName;
                const isActive = machine ? machine === m.name : isLocal;
                return (
                  <DropdownMenuItem
                    key={m.name}
                    onClick={() => selectMachine(isLocal ? null : m.name)}
                    aria-label={`Use machine ${m.name}`}
                  >
                    <span className="flex-1 truncate">{m.name}</span>
                    {isLocal ? (
                      <span className="text-[10px] text-muted-foreground">this page</span>
                    ) : null}
                    {isActive ? <Check className="size-3.5" /> : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}

      {mode === 'new' ? (
        <div
          className={`flex min-h-0 flex-1 flex-col p-2.5 ${dragActive ? 'rounded-lg ring-2 ring-primary/40' : ''}`}
          onDragOver={
            canAttachImages
              ? (e) => {
                  e.preventDefault();
                  setDragActive(true);
                }
              : undefined
          }
          onDragLeave={canAttachImages ? () => setDragActive(false) : undefined}
          onDrop={
            canAttachImages
              ? (e) => {
                  e.preventDefault();
                  setDragActive(false);
                  void imageAttachments.addFromDataTransfer(e.dataTransfer);
                }
              : undefined
          }
        >
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onPaste={(e) => imageAttachments.handlePaste(e, canAttachImages)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="Delegate a task to a new agent…"
            aria-label="New session prompt"
            className="min-h-0 flex-1 resize-none text-[13px]"
          />
          <AttachmentTray
            items={imageAttachments.items}
            onRemove={imageAttachments.remove}
            className="px-0 pt-2"
          />
          <div className="mt-2 flex items-center gap-2 overflow-x-auto [&_button]:shrink-0">
            {canAttachImages && (
              <AttachButton
                onFiles={(files) => void imageAttachments.addFiles(files)}
                disabled={submitting}
              />
            )}
            <ProjectPicker value={projectPath} onChange={handleProjectChange} apiBase={remoteBase} />
            <BranchPicker
              projectPath={projectPath}
              value={baseBranch}
              onChange={handleBranchChange}
              apiBase={remoteBase}
            />
            <WorkspaceModePicker
              value={workspaceMode}
              onChange={setWorkspaceMode}
              disabled={!projectPath}
            />
            <ModelPicker
              value={model}
              modelOptions={modelOptions}
              onChange={(modelId, providerId, options) => {
                if (!modelSupportsImages(catalog, providerId, modelId)) imageAttachments.clearWithTokens();
                setModel(modelId);
                setProvider(providerId);
                setModelOptions(options ?? {});
              }}
              providers={activeProviders}
              compact
            />
            <Button
              type="button"
              size="sm"
              className="ml-auto h-8 shrink-0"
              disabled={submitting || prompt.trim().length === 0 || !model}
              onClick={() => void submit()}
            >
              <CornerDownLeft className="size-3.5" />
              Start
            </Button>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {machine && remoteSessions === null ? (
            <p className="p-3 text-[12px] text-muted-foreground">Loading sessions from {machine}…</p>
          ) : attachable.length === 0 ? (
            <p className="p-3 text-[12px] text-muted-foreground">
              {machine
                ? `No active sessions on ${machine}.`
                : 'No active sessions to attach. Start a new one, or spin up an agent from the sidebar.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {attachable.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onBind(s.id, machine ?? undefined)}
                    className="flex w-full items-start gap-2 rounded-md p-2 text-left transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none"
                    aria-label={`Attach ${s.title}`}
                  >
                    <StatusDot status={s.status} className="mt-1" />
                    <span className="mt-0.5 shrink-0 leading-none text-muted-foreground">
                      <ProviderIcon providerId={s.provider} className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[13px]">{s.title}</span>
                        {boundSessionIds.has(s.id) ? (
                          <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                            in grid
                          </span>
                        ) : null}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {projectDisplayName(s.projectPath) ?? 'Chat'}
                        {s.model ? ` · ${prettyModelName(s.model)}` : ''}
                        {` · ${statusLabel(s.status)} · ${relativeTime(s.updatedAt)}`}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      type="button"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'flex items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-secondary text-secondary-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {children}
    </button>
  );
}
