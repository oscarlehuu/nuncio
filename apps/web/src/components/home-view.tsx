import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRightLeft, ArrowUp, BookOpen, Bug, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { BranchPicker } from './branch-picker';
import { ModelPicker } from './model-picker';
import { ProjectPicker } from './project-picker';
import { ApprovalModePicker, type ApprovalMode } from './approval-mode-picker';
import { WorkspaceModePicker, type WorkspaceMode } from './workspace-mode-picker';
import { cn } from '@/lib/utils';
import { isCodexApprovalEngine } from '../lib/codex-approval-engine';
import { defaultOptionsForModel } from '../lib/model-picker-catalog';
import type { ModelOptionsMap } from '../lib/model-options';
import {
  loadModelPreference,
  resolveModelSelection,
  saveModelPreference,
} from '../lib/model-preference';
import { projectDisplayName } from '../lib/projects';
import { type MessageAttachment } from '../lib/api';
import { useComposerAttachments } from '../lib/use-composer-attachments';
import { AttachButton, AttachmentTray } from './attachment-tray';
import { QuotaChip } from './quota-chip';
import { takeComposerDraft } from '../lib/composer-draft';
import { useProviderUsage } from '../lib/use-provider-usage';
import { resolveUsageProvider } from '../lib/usage-display';
import {
  loadProjectPreference,
  isNuncioSessionBranch,
  recordBranchSelection,
  recordProjectSelection,
  resolveWorkspacePreference,
} from '../lib/project-preference';
import {
  modelById,
  normalizeModelCatalog,
  pickDefaultModelSelection,
  type ModelProvider,
} from '../lib/model-providers';

/** Quiet starter prompts for the empty landing — click prefills the composer. */
const STARTERS = [
  { icon: Bug, label: 'Fix a bug', prompt: 'Find and fix the bug where ' },
  { icon: Sparkles, label: 'Add a feature', prompt: 'Add a feature that ' },
  {
    icon: BookOpen,
    label: 'Explain the codebase',
    prompt: 'Give me a tour of how this codebase is structured and where the main pieces live.',
  },
] as const;

interface HomeViewProps {
  /** Embedded in the Board top bar: compact, top-aligned, no landing chrome. */
  embedded?: boolean;
  /** Rendered inside another scroll surface (Home): full composer, no outer landing wrapper. */
  inline?: boolean;
  /** Increment to focus the prompt textarea (drives the new-agent shortcut). */
  focusKey?: number;
  sessionCount: number;
  providers?: ModelProvider[];
  onSubmit: (
    prompt: string,
    model?: string,
    provider?: string,
    projectPath?: string,
    baseBranch?: string,
    modelOptions?: ModelOptionsMap,
    useWorktree?: boolean,
    attachments?: MessageAttachment[],
  ) => Promise<void>;
  onContinueOnMobile?: () => void;
  approvalMode?: ApprovalMode;
  onApprovalModeChange?: (mode: ApprovalMode) => void | Promise<void>;
  loading?: boolean;
}

export function HomeView({
  embedded,
  inline,
  focusKey,
  providers,
  onSubmit,
  onContinueOnMobile,
  approvalMode = 'full-access',
  onApprovalModeChange,
  loading,
}: HomeViewProps) {
  const initialWorkspace = resolveWorkspacePreference();
  // One-shot prefill (e.g. "Start session from issue") wins over the sticky workspace.
  const [draft] = useState(() => takeComposerDraft());
  const [prompt, setPrompt] = useState(draft?.prompt ?? '');
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState<string | undefined>();
  const [modelOptions, setModelOptions] = useState<ModelOptionsMap>({});
  const [projectPath, setProjectPath] = useState<string | undefined>(
    draft?.projectPath ?? initialWorkspace.projectPath,
  );
  const [baseBranch, setBaseBranch] = useState<string | undefined>(initialWorkspace.baseBranch);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('local');
  const [dragActive, setDragActive] = useState(false);
  const imageAttachments = useComposerAttachments(setPrompt);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!focusKey) return;
    promptRef.current?.focus();
  }, [focusKey]);

  const catalogLoaded = Boolean(providers && providers.length > 0);
  const catalog = useMemo(() => normalizeModelCatalog(providers ?? []), [providers]);
  // Attach affordance follows the selected provider's declared capability, so it
  // lights up automatically as each provider gains image support.
  const canAttachImages = useMemo(
    () => (provider ? (catalog.find((p) => p.id === provider)?.capabilities?.images ?? false) : false),
    [provider, catalog],
  );
  const useWorktree = workspaceMode === 'worktree';
  const showApprovalMode =
    !!onApprovalModeChange && isCodexApprovalEngine(provider, model);

  useEffect(() => {
    if (!catalogLoaded || !providers) return;
    const lookup = modelById(catalog);
    if (model && provider && lookup[model]) return;
    const resolved = resolveModelSelection(providers, loadModelPreference());
    if (resolved) {
      setModel(resolved.modelId);
      setProvider(resolved.providerId);
      setModelOptions(resolved.modelOptions);
      return;
    }
    const picked = pickDefaultModelSelection(providers);
    if (picked) {
      setModel(picked.modelId);
      setProvider(picked.providerId);
      setModelOptions(defaultOptionsForModel(lookup[picked.modelId]));
    }
  }, [catalogLoaded, providers, model, provider, catalog]);

  const handleSubmit = async () => {
    const text = prompt.trim();
    if (!text || loading || !catalogLoaded || !model || !provider) return;
    const selected = modelById(catalog)[model];
    const hasConfigurable =
      (selected?.options?.length ?? 0) > 0 || (selected?.variants?.length ?? 0) > 0;
    const optionsPayload = hasConfigurable ? modelOptions : undefined;
    const stagedItems = imageAttachments.items;
    const attachments = imageAttachments.attachments;
    imageAttachments.clear();
    try {
      await onSubmit(
        text,
        model,
        provider,
        projectPath,
        baseBranch,
        optionsPayload,
        useWorktree,
        attachments.length > 0 ? attachments : undefined,
      );
    } catch (error) {
      imageAttachments.restore(stagedItems);
      throw error;
    }
    setPrompt('');
    setWorkspaceMode('local');
  };

  const handleModelChange = (
    modelId: string,
    providerId: string,
    options?: ModelOptionsMap,
  ) => {
    setModel(modelId);
    setProvider(providerId);
    const nextOptions = options ?? {};
    setModelOptions(nextOptions);
    saveModelPreference({
      modelId,
      providerId,
      modelOptions: Object.keys(nextOptions).length > 0 ? nextOptions : undefined,
    });
  };

  const handleProjectChange = useCallback((path: string) => {
    setProjectPath(path);
    const savedBranch = loadProjectPreference().lastBranchByProject?.[path];
    setBaseBranch(isNuncioSessionBranch(savedBranch) ? undefined : savedBranch);
    recordProjectSelection(path, projectDisplayName(path) ?? undefined);
  }, []);

  const handleBranchChange = useCallback((branch: string) => {
    setBaseBranch(branch);
    if (projectPath) recordBranchSelection(projectPath, branch);
  }, [projectPath]);

  const canSend = Boolean(prompt.trim()) && !loading && catalogLoaded && !!model && !!provider;
  const usageProvider = resolveUsageProvider(provider, model);
  const { snapshots: usageSnapshots, reload: reloadUsage } = useProviderUsage(usageProvider);

  return (
    <section
      className={cn(
        'flex flex-col items-center',
        embedded
          ? 'w-full py-3'
          : inline
            ? 'w-full'
            : 'flex-1 justify-center p-6 pt-16 md:pt-6 overflow-y-auto',
      )}
    >
      <div className="w-full max-w-[720px]">
        {/* Quiet context row — Cursor's text-pickers sit above the composer. */}
        <div className="home-composer-context-row flex flex-wrap items-center justify-center gap-x-1 gap-y-1 mb-3">
          <ProjectPicker value={projectPath} onChange={handleProjectChange} variant="text" />
          <span aria-hidden className="text-muted-foreground/40 select-none">
            ·
          </span>
          <BranchPicker
            projectPath={projectPath}
            value={baseBranch}
            onChange={handleBranchChange}
            variant="text"
          />
          <span aria-hidden className="text-muted-foreground/40 select-none">
            ·
          </span>
          <WorkspaceModePicker
            value={workspaceMode}
            onChange={setWorkspaceMode}
            disabled={!projectPath}
            variant="text"
          />
        </div>

        <div
          className={cn(
            'home-composer flex flex-col rounded-2xl border bg-card shadow-e2 surface-lit transition-shadow focus-within:ring-2 focus-within:ring-ring/40',
            dragActive ? 'border-primary ring-2 ring-primary/40' : 'border-border/70',
          )}
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
          <div className="home-composer-prompt-frame flex flex-col">
            <AttachmentTray items={imageAttachments.items} onRemove={imageAttachments.remove} />
            <Textarea
              ref={promptRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={(e) => imageAttachments.handlePaste(e, canAttachImages)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
              placeholder="Ask Nuncio to build features, fix bugs, or work on your code…"
              className={cn(
                'shrink-0 resize-none border-0 shadow-none bg-transparent text-md px-5 pb-2.5 focus-visible:ring-0 focus-visible:border-0',
                // Embedded (board top bar) reads as a docked task bar, not a hero:
                // half the height so it doesn't stack a second full composer over the board.
                embedded ? 'min-h-[60px] pt-3' : 'min-h-[112px] pt-5',
              )}
            />
            {showApprovalMode ? (
              <div className="home-composer-prompt-controls flex items-center gap-2 px-4 pb-1">
                <ApprovalModePicker
                  value={approvalMode}
                  onChange={onApprovalModeChange}
                  surface="embedded"
                />
              </div>
            ) : null}
          </div>
          <div className="home-composer-bar flex items-center gap-2 px-4 pb-3.5 pt-1.5">
            {canAttachImages && (
              <AttachButton
                onFiles={(files) => void imageAttachments.addFiles(files)}
                disabled={loading}
              />
            )}
            <div className="home-composer-pickers flex min-w-0 flex-1 items-center overflow-x-auto [&_button]:shrink-0">
              <ModelPicker
                value={model}
                modelOptions={modelOptions}
                onChange={handleModelChange}
                providers={providers}
                variant="text"
              />
            </div>
            <QuotaChip
              activeProvider={usageProvider}
              snapshots={usageSnapshots}
              onOpen={() => void reloadUsage(true)}
            />
            {onContinueOnMobile ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={onContinueOnMobile}
                      aria-label="Continue on mobile"
                    >
                      <ArrowRightLeft />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Continue on mobile</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
            <Button
              type="button"
              size="icon"
              aria-label="Send"
              onClick={() => void handleSubmit()}
              disabled={!canSend}
              className="shrink-0 rounded-full transition-transform active:scale-95 disabled:opacity-40"
            >
              <ArrowUp className="size-4" />
            </Button>
          </div>
        </div>

        {/* Quiet starter chips below the composer — fill the empty state with
         * useful entry points instead of a blank canvas. */}
        {!embedded ? (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {STARTERS.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => setPrompt(s.prompt)}
                className="suggestion-pill transition-colors hover:border-border hover:text-foreground"
              >
                <s.icon className="size-3" aria-hidden />
                {s.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
