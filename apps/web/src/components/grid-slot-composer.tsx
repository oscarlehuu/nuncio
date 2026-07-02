import { useEffect, useMemo, useState } from 'react';
import { CornerDownLeft, Plus, Link2 } from 'lucide-react';
import type { Session } from '../lib/api';
import { relativeTime, statusLabel } from '../lib/api';
import {
  modelById,
  normalizeModelCatalog,
  pickDefaultModelSelection,
  prettyModelName,
  type ModelProvider,
} from '../lib/model-providers';
import { defaultOptionsForModel } from '../lib/model-picker-catalog';
import { loadModelPreference, resolveModelSelection } from '../lib/model-preference';
import { resolveWorkspacePreference } from '../lib/project-preference';
import { projectDisplayName } from '../lib/projects';
import type { ModelOptionsMap } from '../lib/model-options';
import { ProjectPicker } from './project-picker';
import { ModelPicker } from './model-picker';
import { ProviderIcon } from './provider-icon';
import { StatusDot } from './status-dot';
import { Button } from '@/components/ui/button';
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
  ) => Promise<Session | null>;
  onBind: (sessionId: string) => void;
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
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState<string | undefined>();
  const [modelOptions, setModelOptions] = useState<ModelOptionsMap>({});
  const [projectPath, setProjectPath] = useState<string | undefined>(
    () => resolveWorkspacePreference().projectPath,
  );
  const [submitting, setSubmitting] = useState(false);

  const catalog = useMemo(() => normalizeModelCatalog(providers), [providers]);
  const catalogLoaded = providers.length > 0;

  useEffect(() => {
    if (!catalogLoaded) return;
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
  }, [catalogLoaded, providers, catalog, model, provider]);

  const attachable = useMemo(
    () => sessions.filter((s) => s.status !== 'ARCHIVED'),
    [sessions],
  );

  const submit = async () => {
    const text = prompt.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      const selected = modelById(catalog)[model];
      const hasConfigurable =
        (selected?.options?.length ?? 0) > 0 || (selected?.variants?.length ?? 0) > 0;
      const created = await onCreate(
        text,
        model || undefined,
        provider,
        projectPath,
        undefined,
        hasConfigurable ? modelOptions : undefined,
      );
      if (created) setPrompt('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-dashed border-border bg-card/40 text-card-foreground">
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

      {mode === 'new' ? (
        <div className="flex min-h-0 flex-1 flex-col p-2.5">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
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
          <div className="mt-2 flex items-center gap-2 overflow-x-auto [&_button]:shrink-0">
            <ProjectPicker value={projectPath} onChange={setProjectPath} />
            <ModelPicker
              value={model}
              modelOptions={modelOptions}
              onChange={(modelId, providerId, options) => {
                setModel(modelId);
                setProvider(providerId);
                setModelOptions(options ?? {});
              }}
              providers={providers}
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
          {attachable.length === 0 ? (
            <p className="p-3 text-[12px] text-muted-foreground">
              No active sessions to attach. Start a new one, or spin up an agent from the sidebar.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {attachable.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onBind(s.id)}
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
