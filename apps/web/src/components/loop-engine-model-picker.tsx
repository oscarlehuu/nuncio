import { Check, ChevronDown } from 'lucide-react';
import {
  flattenProviders,
  modelById,
  prettyModelName,
  type ModelProvider,
} from '../lib/model-providers';
import { ProviderIcon } from './provider-icon';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface LoopEngineModelPickerProps {
  /** The /api/models catalog — the same source the chat model-picker renders. */
  providers: ModelProvider[];
  /** Per-loop engine override; null = inherit from the project's default engine. */
  engine: string | null;
  /** Per-loop model override; null = the resolved engine's default model. */
  model: string | null;
  /** Fires with both segments; picking an engine always resets model to null. */
  onChange: (engine: string | null, model: string | null) => void;
  /** Denser trigger for the create dialog. */
  compact?: boolean;
}

function SelectionCheck({ active }: { active: boolean }) {
  if (!active) return <span className="size-4 shrink-0" />;
  return <Check className="size-4 shrink-0 text-primary" />;
}

/**
 * The embedded "Engine · Model" control for Autopilot loops — a quiet Cursor-style
 * inline text button (like the chat ModelPicker's `text` variant) whose menu
 * cascades engine → model: top level is 'Inherit from project' + one submenu per
 * provider, each opening 'Provider default' + that engine's model list. Picking an
 * engine row resets the model to the engine's default by construction; the model is
 * only ever set together with its engine. Null-safe: `model: null` renders
 * 'default model'; an unknown/legacy id renders raw.
 */
export function LoopEngineModelPicker({
  providers,
  engine,
  model,
  onChange,
  compact,
}: LoopEngineModelPickerProps) {
  const lookup = modelById(providers);
  const engineLabel = engine
    ? providers.find((p) => p.id === engine)?.name ?? engine
    : 'Inherit from project';
  const knownModel = model ? lookup[model] : undefined;
  const modelLabel = model ? (knownModel ? prettyModelName(knownModel.name) : model) : 'default model';

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className={cn('picker-trigger-text max-w-full', compact && 'h-6')}
          aria-label={`Engine and model: ${engineLabel} · ${modelLabel}`}
        >
          {engine && (
            <ProviderIcon providerId={engine} className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-ui-lg">
            {engineLabel} · {modelLabel}
          </span>
          <ChevronDown className="size-3 opacity-70" data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[260px]">
        <DropdownMenuItem onSelect={() => onChange(null, null)} className="gap-2">
          <SelectionCheck active={engine === null} />
          <span className="truncate">Inherit from project</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {providers.map((p) => {
          const models = flattenProviders([p]);
          const engineActive = engine === p.id;
          return (
            <DropdownMenuSub key={p.id}>
              <DropdownMenuSubTrigger className="gap-2">
                <SelectionCheck active={engineActive} />
                <ProviderIcon providerId={p.id} className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{p.name}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-[360px] w-[240px] overflow-y-auto">
                <DropdownMenuItem onSelect={() => onChange(p.id, null)} className="gap-2">
                  <SelectionCheck active={engineActive && model === null} />
                  <span className="truncate">Provider default</span>
                </DropdownMenuItem>
                {models.length > 0 && <DropdownMenuSeparator />}
                {models.map((m) => (
                  <DropdownMenuItem key={m.id} onSelect={() => onChange(p.id, m.id)} className="gap-2">
                    <SelectionCheck active={engineActive && model === m.id} />
                    <span className="truncate">{prettyModelName(m.name)}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
