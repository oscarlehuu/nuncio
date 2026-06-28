import { useEffect, useState } from 'react';
import { Check, ChevronDown, Zap } from 'lucide-react';
import {
  activeModelOptionBadges,
  booleanOptionsForModel,
  defaultOptionsForModel,
  formatModelPickerLabel,
  isActiveModelSelection,
  mergeOptionsForModel,
  modelHasBooleanOptions,
  modelIsBooleanOnly,
  modelShowsSubmenu,
  modelShowsVariantRows,
  normalizeModelOptions,
  plainRowOptions,
  variantParamsToOptions,
  type ModelOptionBadge,
} from '../lib/model-picker-catalog';
import {
  effortSliderOptions,
  menuSelectOptions,
  modelSupportsFast,
} from '../lib/model-effort-options';
import type { ModelOptionsMap } from '../lib/model-options';
import {
  flattenProviders,
  modelById,
  normalizeModelCatalog,
  prettyModelName,
  type FlatModel,
  type ModelProvider,
} from '../lib/model-providers';
import { ProviderIcon } from './provider-icon';
import { FastLightningToggle } from './fast-lightning-toggle';
import { ModelEffortSlider } from './model-effort-slider';
import { Button } from '@/components/ui/button';
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

export { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from '../lib/model-providers';

interface ModelPickerProps {
  value: string;
  modelOptions?: ModelOptionsMap;
  onChange: (modelId: string, providerId: string, modelOptions?: ModelOptionsMap) => void;
  providers?: ModelProvider[];
}

function SelectionCheck({ active }: { active: boolean }) {
  if (!active) return <span className="size-4 shrink-0" />;
  return <Check className="size-4 shrink-0 text-primary" />;
}

function ModelNameWithBadges({
  name,
  badges,
  nameClassName,
}: {
  name: string;
  badges: ModelOptionBadge[];
  nameClassName?: string;
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
      <span className={cn('truncate', nameClassName)}>{name}</span>
      {badges.length > 0 && (
        <span className="flex shrink-0 items-center gap-1">
          {badges.map((badge) => (
            <span key={badge.id} className="text-[11px] font-normal text-muted-foreground">
              {badge.label}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

function ModelVariantRow({
  model,
  variant,
  active,
  onSelect,
}: {
  model: FlatModel;
  variant: NonNullable<FlatModel['variants']>[number];
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="gap-2">
      <SelectionCheck active={active} />
      <span className="truncate">{variant.label || prettyModelName(model.name)}</span>
    </DropdownMenuItem>
  );
}

function ModelPlainRow({
  model,
  active,
  onSelect,
}: {
  model: FlatModel;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="gap-2">
      <SelectionCheck active={active} />
      <span className="truncate">{prettyModelName(model.name)}</span>
    </DropdownMenuItem>
  );
}

import { cn } from '@/lib/utils';

function absorbMenuPointer(event: React.SyntheticEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function ModelOptionsPanel({
  model,
  current,
  onPatch,
}: {
  model: FlatModel;
  current: ModelOptionsMap;
  onPatch: (next: ModelOptionsMap) => void;
}) {
  const showFast = modelSupportsFast(model);
  const fastOn = current.fast === true;
  const sliders = effortSliderOptions(model);
  const menuSelects = menuSelectOptions(model);
  const otherBooleans = booleanOptionsForModel(model).filter((option) => option.id !== 'fast');

  return (
    <div
      className="flex w-full flex-col gap-3 p-3"
      onPointerDown={absorbMenuPointer}
      onClick={absorbMenuPointer}
    >
      {sliders.map((descriptor) => {
        const value = current[descriptor.id];
        if (typeof value !== 'string') return null;
        return (
          <ModelEffortSlider
            key={descriptor.id}
            label={descriptor.label}
            choices={descriptor.options ?? []}
            value={value}
            onChange={(choiceId) => onPatch({ ...current, [descriptor.id]: choiceId })}
          />
        );
      })}

      {showFast && (
        <>
          {sliders.length > 0 && <div className="border-t border-border" />}
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-sm px-1 py-1 text-left text-sm hover:bg-accent"
            aria-label={fastOn ? 'Turn off fast mode' : 'Turn on fast mode'}
            aria-pressed={fastOn}
            onClick={() => onPatch({ ...current, fast: !fastOn })}
          >
            <span className="text-muted-foreground">Priority</span>
            <Zap
              className={cn(
                'size-4 shrink-0',
                // The menu item's focus:**:text-accent-foreground sets `color` on every
                // descendant — including the lucide <path stroke="currentColor"> — washing
                // the lit icon white on hover. Pin `stroke` directly on the paths (it only
                // touches `color`) so the green survives.
                fastOn ? 'fill-success/25 stroke-success [&_*]:stroke-success' : 'text-muted-foreground',
              )}
              strokeWidth={2}
              aria-hidden
            />
          </button>
        </>
      )}

      {otherBooleans.length > 0 && (
        <>
          {sliders.length > 0 || showFast ? (
            <div className="border-t border-border pt-2" />
          ) : null}
          {otherBooleans.map((option) => {
            const checked = current[option.id] === true;
            return (
              <button
                key={option.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left text-sm hover:bg-accent"
                onClick={() => onPatch({ ...current, [option.id]: !checked })}
              >
                <SelectionCheck active={checked} />
                <span className="truncate">{option.label}</span>
              </button>
            );
          })}
        </>
      )}

      {menuSelects.map((option, idx) => (
        <div key={option.id}>
          {(idx > 0 || sliders.length > 0 || showFast || otherBooleans.length > 0) && (
            <div className="mb-2 border-t border-border pt-2" />
          )}
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">{option.label}</div>
          {(option.options ?? []).map((choice) => {
            const choiceActive = current[option.id] === choice.id;
            return (
              <button
                key={choice.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left text-sm hover:bg-accent"
                onClick={() => onPatch({ ...current, [option.id]: choice.id })}
              >
                <SelectionCheck active={choiceActive} />
                <span className="truncate">{choice.label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ModelSubmenuRow({
  model,
  value,
  modelOptions,
  onSelect,
  onToggle,
  onActivate,
}: {
  model: FlatModel;
  value: string;
  modelOptions?: ModelOptionsMap;
  onSelect: (options: ModelOptionsMap) => void;
  onToggle: (options: ModelOptionsMap) => void;
  onActivate: (options: ModelOptionsMap) => void;
}) {
  const active = value === model.id;
  const booleanOnly = modelIsBooleanOnly(model);
  const current = active
    ? mergeOptionsForModel(model, modelOptions)
    : mergeOptionsForModel(model, plainRowOptions(model));
  const showFast = modelSupportsFast(model);
  const fastOn = current.fast === true;

  const patchOptions = (next: ModelOptionsMap) => {
    if (active) onToggle(next);
    else onSelect(next);
  };

  return (
    <DropdownMenuSub
      onOpenChange={(open) => {
        if (open && !active && booleanOnly) onActivate(plainRowOptions(model));
      }}
    >
      <DropdownMenuSubTrigger className="gap-2">
        <SelectionCheck active={active} />
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {showFast && <FastLightningToggle active={fastOn} />}
          <ModelNameWithBadges
            name={prettyModelName(model.name)}
            badges={active ? activeModelOptionBadges(model, current) : []}
          />
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-[248px] p-0">
        <DropdownMenuItem
          className="cursor-default p-0 focus:bg-popover data-[highlighted]:bg-popover"
          onSelect={(event) => event.preventDefault()}
          onPointerDown={absorbMenuPointer}
        >
          <ModelOptionsPanel model={model} current={current} onPatch={patchOptions} />
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ModelRows({
  models,
  value,
  modelOptions,
  onPick,
  onToggle,
}: {
  models: FlatModel[];
  value: string;
  modelOptions?: ModelOptionsMap;
  onPick: (modelId: string, providerId: string, options?: ModelOptionsMap) => void;
  onToggle: (modelId: string, providerId: string, options: ModelOptionsMap) => void;
}) {
  return (
    <>
      {models.map((model) => {
        if (modelShowsVariantRows(model)) {
          return (model.variants ?? []).map((variant) => {
            const options = variantParamsToOptions(variant.params);
            const active = isActiveModelSelection(value, modelOptions, model.id, options);
            return (
              <ModelVariantRow
                key={`${model.id}:${variant.label}`}
                model={model}
                variant={variant}
                active={active}
                onSelect={() => onPick(model.id, model.providerId, options)}
              />
            );
          });
        }
        if (modelShowsSubmenu(model)) {
          return (
            <ModelSubmenuRow
              key={model.id}
              model={model}
              value={value}
              modelOptions={modelOptions}
              onSelect={(options) => onPick(model.id, model.providerId, options)}
              onToggle={(options) => onToggle(model.id, model.providerId, options)}
              onActivate={(options) => onToggle(model.id, model.providerId, options)}
            />
          );
        }
        const rowOptions = plainRowOptions(model);
        const active = isActiveModelSelection(value, modelOptions, model.id, rowOptions);
        return (
          <ModelPlainRow
            key={model.id}
            model={model}
            active={active}
            onSelect={() => onPick(model.id, model.providerId, rowOptions)}
          />
        );
      })}
    </>
  );
}

export function ModelPicker({ value, modelOptions, onChange, providers }: ModelPickerProps) {
  const catalog = normalizeModelCatalog(providers ?? []);
  const [open, setOpen] = useState(false);
  const lookup = modelById(catalog);
  const selected = lookup[value];

  useEffect(() => {
    const lookupForProviders = modelById(catalog);
    if (!value || lookupForProviders[value]) return;
    const first = flattenProviders(catalog)[0];
    if (first) onChange(first.id, first.providerId, defaultOptionsForModel(first));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChange, catalog, value]);

  const pick = (modelId: string, providerId: string, options?: ModelOptionsMap) => {
    const model = lookup[modelId];
    const normalized = normalizeModelOptions(options);
    let payload =
      model && (model.options?.length || model.variants?.length || modelHasBooleanOptions(model))
        ? mergeOptionsForModel(model, normalized)
        : undefined;
    if (payload && Object.keys(payload).length === 0) payload = undefined;
    onChange(modelId, providerId, payload);
    setOpen(false);
  };

  const toggleBoolean = (modelId: string, providerId: string, options: ModelOptionsMap) => {
    const model = lookup[modelId];
    const payload = model ? mergeOptionsForModel(model, options) : normalizeModelOptions(options);
    onChange(modelId, providerId, payload);
  };

  const triggerBadges = activeModelOptionBadges(selected, modelOptions);
  const triggerName = selected ? prettyModelName(selected.name) : 'Select model';
  const triggerLabel = formatModelPickerLabel(selected, modelOptions);
  const showFastOnTrigger = selected ? modelSupportsFast(selected) : false;
  const fastOnTrigger = modelOptions?.fast === true;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="composer-picker-trigger h-8 gap-1.5 px-2.5 max-w-[300px]"
          aria-label={triggerLabel}
        >
          <ProviderIcon
            providerId={selected?.providerId ?? 'pi'}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          {showFastOnTrigger && (
            <FastLightningToggle active={fastOnTrigger} />
          )}
          <ModelNameWithBadges
            name={triggerName}
            badges={triggerBadges}
            nameClassName="font-medium text-[13px]"
          />
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[260px]">
        {catalog.map((p, idx) => {
          const flat = flattenProviders([p]);
          if (flat.length === 0) return null;
          return (
            <div key={p.id}>
              {idx > 0 && <DropdownMenuSeparator />}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2">
                  <ProviderIcon providerId={p.id} className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{p.name}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  className={cn('max-h-[360px] overflow-y-auto', flat.length > 8 ? 'w-[280px]' : 'w-[260px]')}
                >
                  <ModelRows
                    models={flat}
                    value={value}
                    modelOptions={modelOptions}
                    onPick={pick}
                    onToggle={toggleBoolean}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
