import { useEffect, useState, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react';
import { Check, ChevronDown, Search, Zap } from 'lucide-react';
import {
  activeModelOptionBadges,
  booleanOptionsForModel,
  defaultOptionsForModel,
  formatModelPickerLabel,
  isActiveModelSelection,
  mergeOptionsForModel,
  modelHasBooleanOptions,
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
  loadRecentModels,
  recordRecentModel,
  type RecentModel,
} from '../lib/model-preference';
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';

export { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from '../lib/model-providers';

interface BaseModelPickerProps {
  providers?: ModelProvider[];
  /** 'boxed' = composer toolbar chip; 'text' = borderless Cursor context label. */
  variant?: 'boxed' | 'text';
  /** Fired when the menu opens (not on close). Lets a held subagent row re-arm
   *  its countdown so the window can't expire mid-selection. */
  onOpen?: () => void;
  /** Lock the trigger (e.g. while a model change for this row is in flight). */
  disabled?: boolean;
  /** Prevent automatic fallback selection when callers need nullable/inherited model state. */
  autoPick?: boolean;
}

interface ChatModelPickerProps extends BaseModelPickerProps {
  pairMode?: never;
  value: string;
  modelOptions?: ModelOptionsMap;
  onChange: (modelId: string, providerId: string, modelOptions?: ModelOptionsMap) => void;
}

interface PairModelPickerProps extends BaseModelPickerProps {
  pairMode: 'engine+model';
  /** Null engine means inherit the project's configured engine. */
  engine: string | null;
  /** Null model means use the selected/inherited provider default. */
  model: string | null;
  onPairChange: (engine: string | null, model: string | null) => void;
  inheritOption?: { label: string };
  providerDefaultOption?: boolean;
  compact?: boolean;
}

type ModelPickerProps = ChatModelPickerProps | PairModelPickerProps;

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
            <span key={badge.id} className="text-ui-sm font-normal text-muted-foreground">
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

function absorbMenuPointer(event: SyntheticEvent) {
  event.preventDefault();
  event.stopPropagation();
}

const MODEL_PANEL_STYLE = {
  minWidth: 'min(22rem, calc(100vw - 24px))',
  maxWidth: 'calc(100vw - 24px)',
} satisfies CSSProperties;

const MODEL_PANEL_CLASS = 'max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto';

/* A provider with more models than this collapses to its first few plus an
 * "All N models" expander, so browsing stays one screen tall. */
const FEATURED_COLLAPSE_THRESHOLD = 6;
const FEATURED_VISIBLE = 3;

interface CliChip {
  id: string | null;
  label: string;
}

function ModelPickerFlatContent({
  children,
  query,
  onQueryChange,
  chips,
  activeChip = null,
  onChipChange,
}: {
  children: ReactNode;
  query: string;
  onQueryChange: (query: string) => void;
  /** Optional CLI filter row under the search box; one chip per provider plus All. */
  chips?: CliChip[];
  activeChip?: string | null;
  onChipChange?: (id: string | null) => void;
}) {
  return (
    <DropdownMenuContent
      align="start"
      collisionPadding={12}
      data-testid="model-picker-flat-panel"
      data-collision-padding="12"
      style={MODEL_PANEL_STYLE}
      className={cn(MODEL_PANEL_CLASS, 'w-[min(22rem,calc(100vw-24px))] p-0')}
    >
      <div className="sticky top-0 z-10 border-b border-border/60 bg-popover p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="Search models"
            className="h-8 pl-8"
          />
        </div>
        {chips && chips.length > 2 && (
          <div className="mt-2 flex flex-wrap items-center gap-1" role="group" aria-label="Filter by CLI">
            {chips.map((chip) => {
              const active = activeChip === chip.id;
              return (
                <button
                  key={chip.id ?? 'all'}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onChipChange?.(chip.id)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-ui-sm transition-colors',
                    active
                      ? 'border-foreground/40 bg-accent text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="p-1">{children}</div>
    </DropdownMenuContent>
  );
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
          <div className="mb-1 text-ui-sm font-medium text-muted-foreground">{option.label}</div>
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

function ModelRows({
  models,
  value,
  modelOptions,
  expandedModelId,
  expandedOptions,
  onPick,
  onToggle,
  onExpand,
}: {
  models: FlatModel[];
  value: string;
  modelOptions?: ModelOptionsMap;
  expandedModelId: string | null;
  expandedOptions: ModelOptionsMap | null;
  onPick: (modelId: string, providerId: string, options?: ModelOptionsMap) => void;
  onToggle: (modelId: string, providerId: string, options: ModelOptionsMap) => void;
  onExpand: (modelId: string, options: ModelOptionsMap) => void;
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
        const configurable = (model.options?.length ?? 0) > 0 || modelHasBooleanOptions(model);
        if (configurable) {
          const active = value === model.id;
          const expanded = expandedModelId === model.id;
          const current = active
            ? mergeOptionsForModel(model, modelOptions)
            : expanded && expandedOptions
              ? mergeOptionsForModel(model, expandedOptions)
              : mergeOptionsForModel(model, plainRowOptions(model));
          const showFast = modelSupportsFast(model);
          const fastOn = current.fast === true;
          const selectConfigurable = () => {
            const next = mergeOptionsForModel(model, active ? current : plainRowOptions(model));
            onExpand(model.id, next);
            onToggle(model.id, model.providerId, next);
          };
          const patchConfigurable = (next: ModelOptionsMap) => {
            const merged = mergeOptionsForModel(model, next);
            onExpand(model.id, merged);
            onToggle(model.id, model.providerId, merged);
          };
          return (
            <div key={model.id}>
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  selectConfigurable();
                }}
                className="gap-2"
              >
                <SelectionCheck active={active} />
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  {showFast && <FastLightningToggle active={fastOn} />}
                  <ModelNameWithBadges
                    name={prettyModelName(model.name)}
                    badges={active ? activeModelOptionBadges(model, current) : []}
                  />
                </span>
              </DropdownMenuItem>
              {(active || expanded) && (
                <div className="mx-1 mb-1 rounded-md border border-border/60 bg-muted/20">
                  <ModelOptionsPanel model={model} current={current} onPatch={patchConfigurable} />
                </div>
              )}
            </div>
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

function PairModeModelPicker({
  providers,
  engine,
  model,
  onPairChange,
  inheritOption,
  providerDefaultOption,
  variant = 'text',
  compact,
}: PairModelPickerProps) {
  const catalog = normalizeModelCatalog(providers ?? []);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const lookup = modelById(catalog);
  const engineLabel = engine ? catalog.find((p) => p.id === engine)?.name ?? engine : inheritOption?.label ?? 'Inherit';
  const knownModel = model ? lookup[model] : undefined;
  const modelLabel = model ? (knownModel ? prettyModelName(knownModel.name) : model) : 'default model';
  const queryLower = query.trim().toLowerCase();

  const pickPair = (nextEngine: string | null, nextModel: string | null) => {
    onPairChange(nextEngine, nextModel);
    setOpen(false);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            variant === 'text'
              ? 'picker-trigger-text max-w-full'
              : 'composer-picker-trigger h-8 gap-1.5 px-2.5 max-w-[300px]',
            compact && 'h-6',
          )}
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
      <ModelPickerFlatContent query={query} onQueryChange={setQuery}>
        {inheritOption && (
          <>
            <DropdownMenuItem onSelect={() => pickPair(null, null)} className="gap-2">
              <SelectionCheck active={engine === null} />
              <span className="truncate">{inheritOption.label}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {catalog.map((p) => {
          const providerMatches = !queryLower || p.name.toLowerCase().includes(queryLower) || p.id.toLowerCase().includes(queryLower);
          const models = flattenProviders([p]).filter((m) => {
            if (!queryLower || providerMatches) return true;
            return (
              m.id.toLowerCase().includes(queryLower) ||
              m.name.toLowerCase().includes(queryLower) ||
              prettyModelName(m.name).toLowerCase().includes(queryLower) ||
              m.groupName.toLowerCase().includes(queryLower)
            );
          });
          if (!providerMatches && models.length === 0) return null;
          const engineActive = engine === p.id;
          return (
            <div key={p.id}>
              <DropdownMenuLabel className="flex items-center gap-1.5 px-2 pt-2 text-[11px] uppercase tracking-wide">
                <ProviderIcon providerId={p.id} className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{p.name}</span>
              </DropdownMenuLabel>
                {providerDefaultOption && (
                  <DropdownMenuItem
                    onSelect={() => pickPair(p.id, null)}
                    className="gap-2"
                    aria-label={`${p.name} provider default`}
                  >
                    <SelectionCheck active={engineActive && model === null} />
                    <span className="truncate">Provider default</span>
                  </DropdownMenuItem>
                )}
                {providerDefaultOption && models.length > 0 && <DropdownMenuSeparator />}
                {models.map((m) => (
                  <DropdownMenuItem key={m.id} onSelect={() => pickPair(p.id, m.id)} className="gap-2">
                    <SelectionCheck active={engineActive && model === m.id} />
                    <span className="truncate">{prettyModelName(m.name)}</span>
                  </DropdownMenuItem>
                ))}
            </div>
          );
        })}
      </ModelPickerFlatContent>
    </DropdownMenu>
  );
}

function ChatModelPicker({
  value,
  modelOptions,
  onChange,
  providers,
  variant = 'boxed',
  onOpen,
  disabled,
  autoPick = true,
}: ChatModelPickerProps) {
  const catalog = normalizeModelCatalog(providers ?? []);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);
  const [expandedOptions, setExpandedOptions] = useState<ModelOptionsMap | null>(null);
  const [cliFilter, setCliFilter] = useState<string | null>(null);
  const [expandedProviders, setExpandedProviders] = useState<ReadonlySet<string>>(new Set());
  const [recents, setRecents] = useState<RecentModel[]>([]);
  const asText = variant === 'text';
  const lookup = modelById(catalog);
  const selected = lookup[value];
  const queryLower = query.trim().toLowerCase();

  useEffect(() => {
    if (!autoPick) return;
    const lookupForProviders = modelById(catalog);
    if (!value || lookupForProviders[value]) return;
    const first = flattenProviders(catalog)[0];
    if (first) onChange(first.id, first.providerId, defaultOptionsForModel(first));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPick, onChange, catalog, value]);

  const pick = (modelId: string, providerId: string, options?: ModelOptionsMap) => {
    const model = lookup[modelId];
    const normalized = normalizeModelOptions(options);
    let payload =
      model && (model.options?.length || model.variants?.length || modelHasBooleanOptions(model))
        ? mergeOptionsForModel(model, normalized)
        : undefined;
    if (payload && Object.keys(payload).length === 0) payload = undefined;
    // Persist only — the on-screen Recent list stays stable while the menu is open.
    recordRecentModel({ modelId, providerId });
    onChange(modelId, providerId, payload);
    setOpen(false);
  };

  const toggleBoolean = (modelId: string, providerId: string, options: ModelOptionsMap) => {
    const model = lookup[modelId];
    const payload = model ? mergeOptionsForModel(model, options) : normalizeModelOptions(options);
    recordRecentModel({ modelId, providerId });
    onChange(modelId, providerId, payload);
  };

  const expandModel = (modelId: string, options: ModelOptionsMap) => {
    setExpandedModelId(modelId);
    setExpandedOptions(options);
  };

  const visibleCatalog = cliFilter ? catalog.filter((p) => p.id === cliFilter) : catalog;
  // Filtering to one CLI means "show me that CLI's whole catalog" — no collapse.
  const collapseEnabled = !queryLower && !cliFilter;
  const recentModels =
    queryLower || cliFilter
      ? []
      : recents
          .map((recent) => lookup[recent.modelId])
          .filter(
            (model, index): model is FlatModel =>
              !!model && model.providerId === recents[index]?.providerId,
          );

  const triggerBadges = activeModelOptionBadges(selected, modelOptions);
  const triggerName = selected ? prettyModelName(selected.name) : 'Select model';
  const triggerLabel = formatModelPickerLabel(selected, modelOptions);
  const showFastOnTrigger = selected ? modelSupportsFast(selected) : false;
  const fastOnTrigger = modelOptions?.fast === true;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (disabled) return;
        if (next && !open) {
          onOpen?.();
          setRecents(loadRecentModels());
        }
        if (!next) {
          setCliFilter(null);
          setExpandedProviders(new Set());
        }
        setOpen(next);
      }}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className={cn(
            asText
              ? 'picker-trigger-text max-w-[300px]'
              : 'composer-picker-trigger h-8 gap-1.5 px-2.5 max-w-[300px]',
          )}
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
            nameClassName={asText ? 'text-ui-lg' : 'font-medium text-ui-lg'}
          />
          <ChevronDown className="size-3 opacity-70" data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <ModelPickerFlatContent
        query={query}
        onQueryChange={setQuery}
        chips={[{ id: null, label: 'All' }, ...catalog.map((p) => ({ id: p.id, label: p.name }))]}
        activeChip={cliFilter}
        onChipChange={setCliFilter}
      >
        {recentModels.length > 0 && (
          <>
            <DropdownMenuLabel className="px-2 pt-2 text-[11px] uppercase tracking-wide">
              Recent
            </DropdownMenuLabel>
            <ModelRows
              models={recentModels}
              value={value}
              modelOptions={modelOptions}
              expandedModelId={expandedModelId}
              expandedOptions={expandedOptions}
              onPick={pick}
              onToggle={toggleBoolean}
              onExpand={expandModel}
            />
          </>
        )}
        {visibleCatalog.map((p, idx) => {
          const providerMatches = !queryLower || p.name.toLowerCase().includes(queryLower) || p.id.toLowerCase().includes(queryLower);
          const flat = flattenProviders([p]).filter((m) => {
            if (!queryLower || providerMatches) return true;
            return (
              m.id.toLowerCase().includes(queryLower) ||
              m.name.toLowerCase().includes(queryLower) ||
              prettyModelName(m.name).toLowerCase().includes(queryLower) ||
              m.groupName.toLowerCase().includes(queryLower)
            );
          });
          if (flat.length === 0) return null;
          const groups = p.groups ?? [];
          const showGroupHeaders = groups.length > 1;
          const collapsed =
            collapseEnabled &&
            flat.length > FEATURED_COLLAPSE_THRESHOLD &&
            !expandedProviders.has(p.id);
          // The active model always stays visible, even when its provider is collapsed.
          const featured = collapsed
            ? [
                ...flat.slice(0, FEATURED_VISIBLE),
                ...flat.filter(
                  (m, index) => index >= FEATURED_VISIBLE && m.id === value,
                ),
              ]
            : flat;
          return (
            <div key={p.id}>
              {(idx > 0 || recentModels.length > 0) && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="flex items-center gap-1.5 px-2 pt-2 text-[11px] uppercase tracking-wide">
                <ProviderIcon providerId={p.id} className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{p.name}</span>
              </DropdownMenuLabel>
                  {collapsed ? (
                    <>
                      <ModelRows
                        models={featured}
                        value={value}
                        modelOptions={modelOptions}
                        expandedModelId={expandedModelId}
                        expandedOptions={expandedOptions}
                        onPick={pick}
                        onToggle={toggleBoolean}
                        onExpand={expandModel}
                      />
                      <DropdownMenuItem
                        onSelect={(event) => {
                          event.preventDefault();
                          setExpandedProviders((prev) => new Set(prev).add(p.id));
                        }}
                        className="gap-2 text-muted-foreground"
                        aria-label={`Show all ${flat.length} ${p.name} models`}
                      >
                        <span className="size-4 shrink-0" />
                        <span className="truncate">
                          All {flat.length} {p.name} models
                        </span>
                        <ChevronDown className="ml-auto size-3.5 shrink-0" aria-hidden />
                      </DropdownMenuItem>
                    </>
                  ) : showGroupHeaders
                    ? groups.map((group, groupIdx) => {
                        if (group.models.length === 0) return null;
                        const groupModels = flattenProviders([{ ...p, groups: [group] }]).filter((m) => flat.some((visible) => visible.id === m.id));
                        if (groupModels.length === 0) return null;
                        return (
                          <div key={group.id}>
                            {groupIdx > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuLabel>{group.name}</DropdownMenuLabel>
                            <ModelRows
                              models={groupModels}
                              value={value}
                              modelOptions={modelOptions}
                              expandedModelId={expandedModelId}
                              expandedOptions={expandedOptions}
                              onPick={pick}
                              onToggle={toggleBoolean}
                              onExpand={expandModel}
                            />
                          </div>
                        );
                      })
                    : (
                      <ModelRows
                        models={flat}
                        value={value}
                        modelOptions={modelOptions}
                        expandedModelId={expandedModelId}
                        expandedOptions={expandedOptions}
                        onPick={pick}
                        onToggle={toggleBoolean}
                        onExpand={expandModel}
                      />
                    )}
            </div>
          );
        })}
      </ModelPickerFlatContent>
    </DropdownMenu>
  );
}

export function ModelPicker(props: ModelPickerProps) {
  if (props.pairMode === 'engine+model') return <PairModeModelPicker {...props} />;
  return <ChatModelPicker {...props} />;
}
