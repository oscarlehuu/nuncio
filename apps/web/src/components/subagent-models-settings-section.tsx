import { useEffect, useState } from 'react';
import { Bot, X } from 'lucide-react';
import { fetchModels } from '../lib/api';
import type { ModelProvider } from '../lib/model-providers';
import {
  parseSubagentModelMap,
  serializeSubagentModelMap,
  setSubagentModel,
  type SubagentModelMap,
} from '../lib/subagent-model-map';
import { ModelPicker } from './model-picker';
import { ProviderIcon } from './provider-icon';
import { Button } from '@/components/ui/button';

const SUBAGENT_MODELS_KEY = 'NUNCIO_SUBAGENT_MODELS';

interface SubagentModelsSettingsSectionProps {
  /** Current stored value of NUNCIO_SUBAGENT_MODELS (JSON map), or null when unset. */
  value: string | null;
  onUpdate: (key: string, value: string) => Promise<void>;
}

/** Per-provider default subagent model. Each row is a borderless ModelPicker
 *  scoped to one provider; an empty selection omits that provider's key so the
 *  server falls back to its own default / the legacy global. */
export function SubagentModelsSettingsSection({ value, onUpdate }: SubagentModelsSettingsSectionProps) {
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [map, setMap] = useState<SubagentModelMap>(() => parseSubagentModelMap(value));

  useEffect(() => {
    setMap(parseSubagentModelMap(value));
  }, [value]);

  useEffect(() => {
    fetchModels()
      .then(setProviders)
      // A model-list outage just hides the picker rows; the setting still persists.
      .catch(() => setProviders([]));
  }, []);

  const commit = (next: SubagentModelMap) => {
    setMap(next);
    void onUpdate(SUBAGENT_MODELS_KEY, serializeSubagentModelMap(next));
  };

  const selectableProviders = providers.filter((p) => !p.unavailable && (p.groups?.length ?? 0) > 0);

  return (
    <div className="border-t border-border bg-muted/10 px-4 py-3">
      <div className="flex items-center gap-2">
        <Bot className="size-4 text-muted-foreground" />
        <span className="text-ui font-semibold text-foreground">Default subagent models</span>
      </div>
      <p className="mt-1 text-ui-sm text-muted-foreground">
        The model each provider hands a spawned subagent when you fan out with /multitask. Leave a
        provider blank to use its built-in default.
      </p>

      <div className="mt-3 divide-y divide-border/50">
        {selectableProviders.length === 0 ? (
          <p className="py-2 text-ui-sm text-muted-foreground">No providers with models are available.</p>
        ) : (
          selectableProviders.map((provider) => {
            const hasOverride = Boolean(map[provider.id]);
            return (
              <div key={provider.id} className="flex items-center justify-between gap-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <ProviderIcon providerId={provider.id} className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-ui text-foreground">{provider.name}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <ModelPicker
                    value={map[provider.id] ?? ''}
                    providers={[provider]}
                    variant="text"
                    compact
                    onChange={(modelId) => commit(setSubagentModel(map, provider.id, modelId))}
                  />
                  {hasOverride && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-6 text-muted-foreground hover:text-foreground"
                      onClick={() => commit(setSubagentModel(map, provider.id, null))}
                      aria-label={`Clear ${provider.name} subagent model — use session default`}
                      title="Use session default"
                    >
                      <X className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
