import { useEffect, useState, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react';
import { Check, ChevronDown, LayoutGrid, Search, Zap } from 'lucide-react';
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
import { cn } from '@/lib/utils';
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
  /** Use the shared low-profile trigger density in composer and form footers. */
  compact?: boolean;
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
}

type ModelPickerProps = ChatModelPickerProps | PairModelPickerProps;

function SelectionCheck({ active }: { active: boolean }) {
  if (!active) return <span className="size-4 shrink-0" />;
  return <Check className="size-4 shrink-0 text-primary" />;
}

function catalogSourceBadges(model: FlatModel | undefined): ModelOptionBadge[] {
  const label = model?.badge?.trim();
  if (!label) return [];
  return [{ id: `catalog:${label}`, label }];
}

function modelRowBadges(
  model: FlatModel | undefined,
  modelOptions: ModelOptionsMap | undefined,
  includeOptionBadges: boolean,
  forTrigger = false,
): ModelOptionBadge[] {
  const source = catalogSourceBadges(model);
  if (!includeOptionBadges) return source;
  return [...source, ...activeModelOptionBadges(model, modelOptions, { forTrigger })];
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

/* Fixed-width leading indicator slot rendered in EVERY model row (order:
 * check → slot → name), so model names start at the same x across all
 * engines: a bolt when the model supports fast, an equal-width spacer
 * otherwise. */
function FastSlot({ model, active = false }: { model: FlatModel; active?: boolean }) {
  if (!modelSupportsFast(model)) {
    return (
      <span
        data-testid="model-fast-slot"
        data-fast="false"
        aria-hidden
        className="inline-flex size-3.5 shrink-0"
      />
    );
  }
  return (
    <span data-testid="model-fast-slot" data-fast="true" className="inline-flex shrink-0">
      <FastLightningToggle active={active} />
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
      <FastSlot model={model} />
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
      <FastSlot model={model} />
      <ModelNameWithBadges
        name={prettyModelName(model.name)}
        badges={catalogSourceBadges(model)}
      />
    </DropdownMenuItem>
  );
}

function absorbMenuPointer(event: SyntheticEvent) {
  event.preventDefault();
  event.stopPropagation();
}

const MODEL_PANEL_STYLE = {
  minWidth: 'min(22rem, calc(100vw - 24px))',
  maxWidth: 'calc(100vw - 24px)',
} satisfies CSSProperties;

const MODEL_PANEL_CLASS =
  'flex max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] flex-col overflow-hidden';

/* A provider with more models than this collapses to its first few plus an
 * "All N models" expander, so browsing stays one screen tall. */
const FEATURED_COLLAPSE_THRESHOLD = 6;
const FEATURED_VISIBLE = 3;

interface CliChip {
  id: string | null;
  label: string;
}

function modelIsConfigurable(model: FlatModel): boolean {
  return (model.options?.length ?? 0) > 0 || modelHasBooleanOptions(model);
}

function ModelPickerFlatContent({
  children,
  query,
  onQueryChange,
  chips,
  activeChip = null,
  onChipChange,
  footer,
}: {
  children: ReactNode;
  query: string;
  onQueryChange: (query: string) => void;
  /** Optional CLI filter row under the search box; one chip per provider plus All. */
  chips?: CliChip[];
  activeChip?: string | null;
  onChipChange?: (id: string | null) => void;
  /** Sticky options dock (effort / priority) for the active model — kept out of the list. */
  footer?: ReactNode;
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
      <div className="shrink-0 border-b border-border/60 bg-popover p-2">
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
                  aria-label={chip.label}
                  aria-pressed={active}
                  title={chip.label}
                  onClick={() => onChipChange?.(chip.id)}
                  className={cn(
                    'inline-flex size-7 items-center justify-center rounded-md border transition-colors',
                    active
                      ? 'border-foreground/40 bg-accent text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {chip.id == null ? (
                    <LayoutGrid className="size-3.5" aria-hidden />
                  ) : (
                    <ProviderIcon providerId={chip.id} className="size-3.5" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div data-testid="model-picker-list" className="min-h-0 flex-1 overflow-y-auto p-1">
        {children}
      </div>
      {footer ? (
        <div
          data-testid="model-picker-options-footer"
          className="shrink-0 border-t border-border/60 bg-popover"
        >
          {footer}
        </div>
      ) : null}
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
      className="flex w-full flex-col gap-3 px-3 py-2.5"
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
          {sliders.length > 0 && <div className="border-t border-border/60" />}
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
            <div className="border-t border-border/60 pt-2" />
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
            <div className="mb-2 border-t border-border/60 pt-2" />
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
  onPick,
  onToggle,
  onExpand,
  plainRows,
  isRowActive,
}: {
  models: FlatModel[];
  value: string;
  modelOptions?: ModelOptionsMap;
  onPick: (modelId: string, providerId: string, options?: ModelOptionsMap) => void;
  onToggle: (modelId: string, providerId: string, options: ModelOptionsMap) => void;
  onExpand: (modelId: string, options: ModelOptionsMap) => void;
  /** Pair mode: every model is a plain (engine, model) row — no variant
   *  expansion and no per-model options panel. */
  plainRows?: boolean;
  /** Pair mode: active means engine AND model match, not just the model id. */
  isRowActive?: (model: FlatModel) => boolean;
}) {
  return (
    <>
      {models.map((model) => {
        if (plainRows) {
          return (
            <ModelPlainRow
              key={model.id}
              model={model}
              active={isRowActive ? isRowActive(model) : value === model.id}
              onSelect={() => onPick(model.id, model.providerId)}
            />
          );
        }
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
        if (modelIsConfigurable(model)) {
          const active = value === model.id;
          const current = active
            ? mergeOptionsForModel(model, modelOptions)
            : mergeOptionsForModel(model, plainRowOptions(model));
          const fastOn = current.fast === true;
          const selectConfigurable = () => {
            const next = mergeOptionsForModel(
              model,
              active ? mergeOptionsForModel(model, modelOptions) : plainRowOptions(model),
            );
            onExpand(model.id, next);
            onToggle(model.id, model.providerId, next);
          };
          return (
            <DropdownMenuItem
              key={model.id}
              onSelect={(event) => {
                event.preventDefault();
                selectConfigurable();
              }}
              className="gap-2"
            >
              <SelectionCheck active={active} />
              <FastSlot model={model} active={fastOn} />
              <ModelNameWithBadges
                name={prettyModelName(model.name)}
                badges={modelRowBadges(model, current, active)}
              />
            </DropdownMenuItem>
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


/* One picker, two modes. Chat mode drives a single model id + options; pair
 * mode drives an (engine, model) pair for loops, where null engine means
 * "inherit" and null model means "provider default". Both modes share the
 * same panel: sticky search, CLI filter chips, featured collapse, and the
 * aligned model rows. */
export function ModelPicker(props: ModelPickerProps) {
  const pair = props.pairMode === 'engine+model' ? props : null;
  const chat = props.pairMode === 'engine+model' ? null : props;
  const { providers, onOpen, disabled, autoPick = true } = props;
  const variant = props.variant ?? (pair ? 'text' : 'boxed');

  const catalog = normalizeModelCatalog(providers ?? []);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);
  const [expandedOptions, setExpandedOptions] = useState<ModelOptionsMap | null>(null);
  const [cliFilter, setCliFilter] = useState<string | null>(null);
  const [expandedProviders, setExpandedProviders] = useState<ReadonlySet<string>>(new Set());
  const [recents, setRecents] = useState<RecentModel[]>([]);
  const asText = variant === 'text';
  const compact = props.compact ?? false;
  const lookup = modelById(catalog);
  const selectedModelId = pair ? pair.model ?? '' : chat!.value;
  const modelOptions = chat?.modelOptions;
  const selected = lookup[selectedModelId];
  const queryLower = query.trim().toLowerCase();

  useEffect(() => {
    if (!autoPick || !chat) return;
    const lookupForProviders = modelById(catalog);
    if (!chat.value || lookupForProviders[chat.value]) return;
    const first = flattenProviders(catalog)[0];
    if (first) chat.onChange(first.id, first.providerId, defaultOptionsForModel(first));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPick, chat?.onChange, catalog, chat?.value]);

  const pick = (modelId: string, providerId: string, options?: ModelOptionsMap) => {
    if (pair) {
      pair.onPairChange(providerId, modelId);
      setOpen(false);
      return;
    }
    const model = lookup[modelId];
    const normalized = normalizeModelOptions(options);
    let payload =
      model && (model.options?.length || model.variants?.length || modelHasBooleanOptions(model))
        ? mergeOptionsForModel(model, normalized)
        : undefined;
    if (payload && Object.keys(payload).length === 0) payload = undefined;
    // Persist only — the on-screen Recent list stays stable while the menu is open.
    recordRecentModel({ modelId, providerId });
    chat!.onChange(modelId, providerId, payload);
    setOpen(false);
  };

  const pickPair = (nextEngine: string | null, nextModel: string | null) => {
    pair?.onPairChange(nextEngine, nextModel);
    setOpen(false);
  };

  const toggleBoolean = (modelId: string, providerId: string, options: ModelOptionsMap) => {
    if (!chat) return;
    const model = lookup[modelId];
    const payload = model ? mergeOptionsForModel(model, options) : normalizeModelOptions(options);
    recordRecentModel({ modelId, providerId });
    chat.onChange(modelId, providerId, payload);
  };

  const expandModel = (modelId: string, options: ModelOptionsMap) => {
    setExpandedModelId(modelId);
    setExpandedOptions(options);
  };

  const seedOptionsDock = (modelId: string | undefined) => {
    if (!modelId) {
      setExpandedModelId(null);
      setExpandedOptions(null);
      return;
    }
    const model = lookup[modelId];
    if (!model || !modelIsConfigurable(model)) {
      setExpandedModelId(null);
      setExpandedOptions(null);
      return;
    }
    setExpandedModelId(model.id);
    setExpandedOptions(
      model.id === selectedModelId
        ? mergeOptionsForModel(model, modelOptions)
        : plainRowOptions(model),
    );
  };

  const visibleCatalog = cliFilter ? catalog.filter((p) => p.id === cliFilter) : catalog;
  // Filtering to one CLI means "show me that CLI's whole catalog" — no collapse.
  const collapseEnabled = !queryLower && !cliFilter;
  const recentModels =
    pair || queryLower || cliFilter
      ? []
      : recents
          .map((recent) => lookup[recent.modelId])
          .filter(
            (model, index): model is FlatModel =>
              !!model && model.providerId === recents[index]?.providerId,
          );

  const triggerBadges = modelRowBadges(selected, modelOptions, true, true);
  const triggerName = selected ? prettyModelName(selected.name) : 'Select model';
  const triggerLabel = formatModelPickerLabel(selected, modelOptions);

  const engineLabel = pair
    ? pair.engine
      ? catalog.find((p) => p.id === pair.engine)?.name ?? pair.engine
      : pair.inheritOption?.label ?? 'Inherit'
    : '';
  const pairModelLabel = pair
    ? pair.model
      ? selected
        ? prettyModelName(selected.name)
        : pair.model
      : 'default model'
    : '';

  // Options dock targets the explicitly expanded model (after a row click), else
  // the current selection when it is configurable — never mid-list.
  const footerModel = !pair
    ? (() => {
        const candidate = expandedModelId ? lookup[expandedModelId] : selected;
        if (!candidate || !modelIsConfigurable(candidate)) return null;
        return candidate;
      })()
    : null;
  const footerCurrent = footerModel
    ? footerModel.id === selectedModelId
      ? mergeOptionsForModel(footerModel, modelOptions)
      : mergeOptionsForModel(footerModel, expandedOptions ?? plainRowOptions(footerModel))
    : null;
  const patchFooter = (next: ModelOptionsMap) => {
    if (!footerModel || !chat) return;
    const merged = mergeOptionsForModel(footerModel, next);
    expandModel(footerModel.id, merged);
    toggleBoolean(footerModel.id, footerModel.providerId, merged);
  };

  const rowPropsShared = {
    value: selectedModelId,
    modelOptions,
    onPick: (modelId: string, providerId: string, options?: ModelOptionsMap) => {
      setExpandedModelId(null);
      setExpandedOptions(null);
      pick(modelId, providerId, options);
    },
    onToggle: toggleBoolean,
    onExpand: expandModel,
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (disabled) return;
        if (next && !open) {
          onOpen?.();
          if (!pair) {
            setRecents(loadRecentModels());
            seedOptionsDock(selectedModelId);
          } else {
            setExpandedModelId(null);
            setExpandedOptions(null);
          }
        }
        if (!next) {
          setCliFilter(null);
          setExpandedProviders(new Set());
          setExpandedModelId(null);
          setExpandedOptions(null);
        }
        setOpen(next);
      }}
      // Pair mode opens inside a modal Radix Dialog: the dialog's scroll lock
      // swallows wheel events over anything outside its own subtree, and a
      // non-modal dropdown never adds its own lock layer — so the portalled
      // list could only be scrolled by dragging the scrollbar. A modal
      // dropdown layers its own scroll lock that allow-lists its content,
      // restoring wheel scrolling. The chat picker keeps non-modal so the
      // composer stays interactive behind the open menu.
      modal={pair ? true : false}
    >
      <DropdownMenuTrigger asChild>
        {pair ? (
          <Button
            variant="outline"
            disabled={disabled}
            data-slot="model-picker-trigger"
            data-density={compact ? 'compact' : 'default'}
            className={cn(
              asText
                ? 'picker-trigger-text max-w-full'
                : 'composer-picker-trigger h-8 gap-1.5 px-2.5 max-w-[300px]',
              compact && 'h-7',
            )}
            aria-label={`Engine and model: ${engineLabel} · ${pairModelLabel}`}
          >
            {pair.engine && (
              <ProviderIcon providerId={pair.engine} className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate text-ui-lg">
              {engineLabel} · {pairModelLabel}
            </span>
            <ChevronDown className="size-3 opacity-70" data-icon="inline-end" />
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={disabled}
            data-slot="model-picker-trigger"
            data-density={compact ? 'compact' : 'default'}
            className={cn(
              asText
                ? 'picker-trigger-text max-w-[300px]'
                : 'composer-picker-trigger h-8 gap-1.5 px-2.5 max-w-[300px]',
              compact && 'h-7',
            )}
            aria-label={triggerLabel}
          >
            <ProviderIcon
              providerId={selected?.providerId ?? 'pi'}
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <ModelNameWithBadges
              name={triggerName}
              badges={triggerBadges}
              nameClassName={asText ? 'text-ui-lg' : 'font-medium text-ui-lg'}
            />
            <ChevronDown className="size-3 opacity-70" data-icon="inline-end" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <ModelPickerFlatContent
        query={query}
        onQueryChange={setQuery}
        chips={[{ id: null, label: 'All' }, ...catalog.map((p) => ({ id: p.id, label: p.name }))]}
        activeChip={cliFilter}
        onChipChange={setCliFilter}
        footer={
          footerModel && footerCurrent ? (
            <ModelOptionsPanel model={footerModel} current={footerCurrent} onPatch={patchFooter} />
          ) : null
        }
      >
        {pair?.inheritOption && (
          <>
            <DropdownMenuItem onSelect={() => pickPair(null, null)} className="gap-2">
              <SelectionCheck active={pair.engine === null} />
              <span className="inline-flex size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{pair.inheritOption.label}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {recentModels.length > 0 && (
          <>
            <DropdownMenuLabel className="px-2 pt-2 text-ui-sm uppercase tracking-wide">
              Recent
            </DropdownMenuLabel>
            <ModelRows models={recentModels} {...rowPropsShared} />
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
          // Pair mode keeps a matching provider visible even with no models,
          // so its "Provider default" row stays selectable.
          if (flat.length === 0 && !(pair && providerMatches)) return null;
          const pairRowProps = pair
            ? {
                plainRows: true as const,
                isRowActive: (m: FlatModel) => pair.engine === m.providerId && pair.model === m.id,
              }
            : {};
          const groups = p.groups ?? [];
          const showGroupHeaders = groups.length > 1;
          // The active model always stays visible, even when its provider is
          // collapsed. In pair mode active means this provider is the chosen
          // engine AND the model matches.
          const activeId = pair ? (pair.engine === p.id ? pair.model : null) : selectedModelId;
          const collapsed =
            collapseEnabled &&
            flat.length > FEATURED_COLLAPSE_THRESHOLD &&
            !expandedProviders.has(p.id);
          const featured = collapsed
            ? [
                ...flat.slice(0, FEATURED_VISIBLE),
                ...flat.filter(
                  (m, index) => index >= FEATURED_VISIBLE && m.id === activeId,
                ),
              ]
            : flat;
          return (
            <div key={p.id}>
              {(idx > 0 || recentModels.length > 0) && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="flex items-center gap-1.5 px-2 pt-2 text-ui-sm uppercase tracking-wide">
                <ProviderIcon providerId={p.id} className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{p.name}</span>
              </DropdownMenuLabel>
              {pair?.providerDefaultOption && (
                <DropdownMenuItem
                  onSelect={() => pickPair(p.id, null)}
                  className="gap-2"
                  aria-label={`${p.name} provider default`}
                >
                  <SelectionCheck active={pair.engine === p.id && pair.model === null} />
                  <span className="inline-flex size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">Provider default</span>
                </DropdownMenuItem>
              )}
              {pair?.providerDefaultOption && flat.length > 0 && <DropdownMenuSeparator />}
                  {collapsed ? (
                    <>
                      <ModelRows models={featured} {...rowPropsShared} {...pairRowProps} />
                      <DropdownMenuItem
                        onSelect={(event) => {
                          event.preventDefault();
                          setExpandedProviders((prev) => new Set(prev).add(p.id));
                        }}
                        className="gap-2 text-muted-foreground"
                        aria-label={`Show all ${flat.length} ${p.name} models`}
                      >
                        <span className="size-4 shrink-0" />
                        <span className="inline-flex size-3.5 shrink-0" aria-hidden />
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
                            <ModelRows models={groupModels} {...rowPropsShared} {...pairRowProps} />
                          </div>
                        );
                      })
                    : (
                      <ModelRows models={flat} {...rowPropsShared} {...pairRowProps} />
                    )}
            </div>
          );
        })}
      </ModelPickerFlatContent>
    </DropdownMenu>
  );
}
