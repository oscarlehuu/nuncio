import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState<string | undefined>();
  const [modelOptions, setModelOptions] = useState<ModelOptionsMap>({});
  const [projectPath, setProjectPath] = useState<string | undefined>(initialWorkspace.projectPath);
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

  return (
    <section className="flex-1 flex flex-col items-center justify-center p-6 pt-16 md:pt-6 overflow-y-auto">
      <div className="w-full max-w-[720px]">
        <div className="text-center mb-8">
          <h1 className="text-[28px] font-medium tracking-tight mb-2">What should I work on?</h1>
          <p className="text-muted-foreground text-[15px] max-w-[480px] mx-auto">
            Delegate a task — write code, fix bugs, open a PR. Your agents keep going while you&apos;re away.
          </p>
        </div>

        <div className="home-composer flex flex-col rounded-xl border border-border bg-background shadow-lg transition-shadow focus-within:ring-2 focus-within:ring-ring/50">
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
              className="min-h-[96px] shrink-0 resize-none border-0 shadow-none bg-transparent text-[15px] px-5 pt-4 pb-2 focus-visible:ring-0 focus-visible:border-0"
            />
            <div className="home-composer-prompt-controls flex items-center justify-between gap-2 px-3 pb-3">
              <div className="flex min-w-0 items-center gap-2">
                {showApprovalMode ? (
                  <ApprovalModePicker
                    value={approvalMode}
                    onChange={onApprovalModeChange}
                    surface="embedded"
                  />
                ) : null}
              </div>
            </div>
          </div>
          <div className="home-composer-bar home-composer-context-row flex items-center gap-2 border-t border-border px-3 pt-2 pb-3">
            <div className="home-composer-pickers flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [&_button]:shrink-0">
              <ProjectPicker value={projectPath} onChange={handleProjectChange} />
              <WorkspaceModePicker
                value={workspaceMode}
                onChange={setWorkspaceMode}
                disabled={!projectPath}
              />
              <BranchPicker
                projectPath={projectPath}
                value={baseBranch}
                onChange={handleBranchChange}
              />
              <ModelPicker
                value={model}
                modelOptions={modelOptions}
                onChange={handleModelChange}
                providers={providers}
              />
            </div>
            {onContinueOnMobile ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="composer-picker-trigger size-8 shrink-0"
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
          </div>
        </div>

        <div className="flex flex-wrap gap-2 justify-center mt-5">
          {availableProviders.map((p) => (
            <Badge
              key={p.id}
              variant="secondary"
              className="gap-1.5 border-border/60 bg-muted/40 font-normal text-foreground"
              aria-label={`${p.name} connected`}
            >
              <ProviderIcon providerId={p.id} className="size-3 shrink-0 text-muted-foreground" />
              <span>{p.name}</span>
              <ConnectionDot />
            </Badge>
          ))}
          <Badge variant="secondary" className="border-border/60 bg-muted/40 font-normal text-muted-foreground">
            {sessionCount} session{sessionCount === 1 ? '' : 's'}
          </Badge>
        </div>
      </div>
    </section>
  );
}
