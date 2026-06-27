import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { fetchModels } from '../lib/api';
import {
  FALLBACK_PROVIDERS,
  flattenProviders,
  modelById,
  type ModelProvider,
} from '../lib/model-providers';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

export { DEFAULT_MODEL_ID } from '../lib/model-providers';

interface ModelPickerProps {
  value: string;
  onChange: (modelId: string, providerId: string) => void;
}

export function ModelPicker({ value, onChange }: ModelPickerProps) {
  const [providers, setProviders] = useState<ModelProvider[]>(FALLBACK_PROVIDERS);
  const [open, setOpen] = useState(false);

  const lookup = modelById(providers);
  const selected = lookup[value];

  useEffect(() => {
    void fetchModels().then(setProviders);
  }, []);

  useEffect(() => {
    const lookupForProviders = modelById(providers);
    if (lookupForProviders[value]) return;
    const first = flattenProviders(providers)[0];
    if (first) onChange(first.id, first.providerId);
  }, [onChange, providers, value]);

  const selectModel = (id: string) => {
    const model = lookup[id];
    if (model) onChange(id, model.providerId);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-8 gap-1.5 px-2.5">
          <span className="size-1.5 rounded-full bg-primary shrink-0" />
          <span className="text-muted-foreground text-[11px]">
            {selected?.providerName ?? 'Pi'}
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="font-medium text-[13px]">{selected?.name ?? 'Fable 5'}</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search models…" />
          <CommandList>
            <CommandEmpty>No model found.</CommandEmpty>
            {providers.map((p) => {
              const flat = flattenProviders([p]);
              if (flat.length === 0) return null;
              return (
                <CommandGroup key={p.id} heading={p.name}>
                  {flat.map((m) => (
                    <CommandItem
                      key={m.id}
                      value={`${m.name} ${m.sub ?? ''} ${m.groupName} ${m.cost ?? ''}`}
                      onSelect={() => selectModel(m.id)}
                      data-checked={m.id === value ? 'true' : undefined}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium truncate">{m.name}</div>
                        {m.sub && (
                          <div className="text-[11px] text-muted-foreground truncate">
                            {m.sub}
                          </div>
                        )}
                      </div>
                      {m.cost && (
                        <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                          {m.cost}
                        </span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
