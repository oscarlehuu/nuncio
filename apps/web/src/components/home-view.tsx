import { useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { BranchPicker } from './branch-picker';
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID, ModelPicker } from './model-picker';
import { ProjectPicker } from './project-picker';
import { ProviderIcon } from './provider-icon';
import { FALLBACK_PROVIDERS, type ModelProvider } from '../lib/model-providers';

interface HomeViewProps {
  sessionCount: number;
  providers?: ModelProvider[];
  onSubmit: (
    prompt: string,
    model?: string,
    provider?: string,
    projectPath?: string,
    baseBranch?: string,
  ) => Promise<void>;
  loading?: boolean;
}

export function HomeView({ sessionCount, providers, onSubmit, loading }: HomeViewProps) {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL_ID);
  const [provider, setProvider] = useState<string | undefined>(DEFAULT_PROVIDER_ID);
  const [projectPath, setProjectPath] = useState<string | undefined>();
  const [baseBranch, setBaseBranch] = useState<string | undefined>();

  const availableProviders = (providers && providers.length > 0
    ? providers
    : FALLBACK_PROVIDERS
  ).filter((p) => !p.unavailable);

  const handleSubmit = async () => {
    const text = prompt.trim();
    if (!text || loading) return;
    await onSubmit(text, model, provider, projectPath, baseBranch);
    setPrompt('');
  };

  const handleModelChange = (modelId: string, providerId: string) => {
    setModel(modelId);
    setProvider(providerId);
  };

  const handleProjectChange = (path: string) => {
    setProjectPath(path);
    setBaseBranch(undefined);
  };

  return (
    <section className="flex-1 flex flex-col items-center justify-center p-6 pt-16 md:pt-6 overflow-y-auto">
      <div className="w-full max-w-[720px]">
        <div className="text-center mb-8">
          <h1 className="text-[28px] font-medium tracking-tight mb-2">What should I work on?</h1>
          <p className="text-muted-foreground text-[15px] max-w-[480px] mx-auto">
            Delegate a task — write code, fix bugs, open a PR. Your agents keep going while you&apos;re away.
          </p>
        </div>

        <div className="home-composer flex flex-col rounded-xl border border-border bg-card shadow-lg transition-shadow focus-within:ring-2 focus-within:ring-ring/50">
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
          <div className="home-composer-bar flex items-center justify-between gap-2 border-t border-border px-3 pt-2 pb-3">
            <div className="home-composer-pickers flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [&_button]:shrink-0">
              <ProjectPicker value={projectPath} onChange={handleProjectChange} />
              <BranchPicker
                projectPath={projectPath}
                value={baseBranch}
                onChange={setBaseBranch}
              />
              <ModelPicker value={model} onChange={handleModelChange} providers={providers} />
            </div>
            <Button
              size="icon-lg"
              aria-label="Send"
              onClick={() => void handleSubmit()}
              disabled={loading || !prompt.trim()}
              className="size-11 md:size-9 shrink-0"
            >
              <Send />
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 justify-center mt-5">
          {availableProviders.map((p) => (
            <Badge key={p.id} variant="secondary" className="gap-1.5">
              <ProviderIcon providerId={p.id} className="size-3" />
              {p.name} connected
            </Badge>
          ))}
          <Badge variant="secondary">
            {sessionCount} session{sessionCount === 1 ? '' : 's'}
          </Badge>
        </div>
      </div>
    </section>
  );
}
