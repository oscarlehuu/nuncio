import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, ArrowUp } from 'lucide-react';
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
import { ProviderIcon } from './provider-icon';
import { ApprovalModePicker, type ApprovalMode } from './approval-mode-picker';
import { WorkspaceModePicker, type WorkspaceMode } from './workspace-mode-picker';
import { ConnectionDot } from './status-dot';
import { isCodexApprovalEngine } from '../lib/codex-approval-engine';
import { defaultOptionsForModel } from '../lib/model-picker-catalog';
import type { ModelOptionsMap } from '../lib/model-options';
import {
  loadModelPreference,
  resolveModelSelection,
  saveModelPreference,
} from '../lib/model-preference';
import { projectDisplayName } from '../lib/projects';
import { takeComposerDraft } from '../lib/composer-draft';
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

interface HomeViewProps {
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
  ) => Promise<void>;
  onContinueOnMobile?: () => void;
  approvalMode?: ApprovalMode;
  onApprovalModeChange?: (mode: ApprovalMode) => void | Promise<void>;
  loading?: boolean;
}

export function HomeView({
  sessionCount,
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

  const catalogLoaded = Boolean(providers && providers.length > 0);
  const availableProviders = (providers ?? []).filter((p) => !p.unavailable);
  const catalog = useMemo(() => normalizeModelCatalog(providers ?? []), [providers]);
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
    await onSubmit(
      text,
      model,
      provider,
      projectPath,
      baseBranch,
      optionsPayload,
      useWorktree,
    );
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

  return (
    <section className="flex-1 flex flex-col items-center justify-center p-6 pt-16 md:pt-6 overflow-y-auto">
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

        <div className="home-composer flex flex-col rounded-xl border border-border/70 bg-card shadow-lg transition-shadow focus-within:ring-2 focus-within:ring-ring/40">
          <div className="home-composer-prompt-frame flex flex-col">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
              placeholder="Ask Nuncio to build features, fix bugs, or work on your code…"
              className="min-h-[104px] shrink-0 resize-none border-0 shadow-none bg-transparent text-md px-5 pt-4 pb-2 focus-visible:ring-0 focus-visible:border-0"
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
          <div className="home-composer-bar flex items-center gap-2 px-3 pb-3 pt-1">
            <div className="home-composer-pickers flex min-w-0 flex-1 items-center overflow-x-auto [&_button]:shrink-0">
              <ModelPicker
                value={model}
                modelOptions={modelOptions}
                onChange={handleModelChange}
                providers={providers}
                variant="text"
              />
            </div>
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

        {/* Quiet suggestion pills — connected providers + session count. */}
        <div className="flex flex-wrap gap-2 justify-center mt-5">
          {availableProviders.map((p) => (
            <span key={p.id} className="suggestion-pill" aria-label={`${p.name} connected`}>
              <ProviderIcon providerId={p.id} className="size-3 shrink-0 text-muted-foreground" />
              <span className="text-foreground">{p.name}</span>
              <ConnectionDot />
            </span>
          ))}
          <span className="suggestion-pill">
            {sessionCount} session{sessionCount === 1 ? '' : 's'}
          </span>
        </div>
      </div>
    </section>
  );
}
