import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  FALLBACK_PROVIDERS,
  flattenProviders,
  modelById,
  normalizeModelCatalog,
  prettyModelName,
  type ModelProvider,
} from '../lib/model-providers';
import { ProviderIcon } from './provider-icon';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from '../lib/model-providers';

interface ModelPickerProps {
  value: string;
  onChange: (modelId: string, providerId: string) => void;
  providers?: ModelProvider[];
}

export function ModelPicker({ value, onChange, providers }: ModelPickerProps) {
  const catalog = normalizeModelCatalog(
    providers && providers.length > 0 ? providers : FALLBACK_PROVIDERS,
  );
  const [open, setOpen] = useState(false);

  const lookup = modelById(catalog);
  const selected = lookup[value];

  useEffect(() => {
    const lookupForProviders = modelById(catalog);
    if (lookupForProviders[value]) return;
    const first = flattenProviders(catalog)[0];
    if (first) onChange(first.id, first.providerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChange, catalog, value]);

  const selectModel = (id: string) => {
    const model = lookup[id];
    if (model) onChange(id, model.providerId);
    setOpen(false);
  };

  const triggerLabel = selected
    ? `${selected.providerName} · ${prettyModelName(selected.name)}`
    : 'Select model';

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-8 gap-1.5 px-2.5">
          <ProviderIcon
            providerId={selected?.providerId ?? 'pi'}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="font-medium text-[13px] truncate max-w-[180px]">{triggerLabel}</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[220px]">
        {catalog.map((p, idx) => {
          const flat = flattenProviders([p]);
          if (flat.length === 0) return null;
          return (
            <div key={p.id}>
              {idx > 0 && <DropdownMenuSeparator />}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ProviderIcon providerId={p.id} className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{p.name}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-[320px] overflow-y-auto w-[240px]">
                  <DropdownMenuRadioGroup value={value}>
                    {flat.map((m) => (
                      <DropdownMenuRadioItem
                        key={m.id}
                        value={m.id}
                        onSelect={() => selectModel(m.id)}
                      >
                        <span className="truncate">{prettyModelName(m.name)}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
