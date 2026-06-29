import type { ModelOptionDescriptor } from './model-options';

/** Select options rendered as a Faster ↔ Smarter slider (Cursor-style). */
export const EFFORT_SLIDER_OPTION_IDS = [
  'reasoning',
  'reasoningEffort',
  'thinkingLevel',
  'effort',
] as const;

export type EffortSliderOptionId = (typeof EFFORT_SLIDER_OPTION_IDS)[number];

export function isEffortSliderOption(id: string): id is EffortSliderOptionId {
  return (EFFORT_SLIDER_OPTION_IDS as readonly string[]).includes(id);
}

export function effortSliderOptions(model: {
  options?: ModelOptionDescriptor[];
}): ModelOptionDescriptor[] {
  return (model.options ?? []).filter(
    (option) => option.type === 'select' && isEffortSliderOption(option.id),
  );
}

export function menuSelectOptions(model: {
  options?: ModelOptionDescriptor[];
}): ModelOptionDescriptor[] {
  return (model.options ?? []).filter(
    (option) => option.type === 'select' && !isEffortSliderOption(option.id),
  );
}

export function modelSupportsFast(model: {
  options?: ModelOptionDescriptor[];
  variants?: Array<{ params: Array<{ id: string; value: string }> }>;
}): boolean {
  if ((model.options ?? []).some((option) => option.id === 'fast' && option.type === 'boolean')) {
    return true;
  }
  const variants = model.variants ?? [];
  return (
    variants.length > 0 &&
    variants.every(
      (variant) =>
        variant.params.length === 1 &&
        variant.params[0]?.id === 'fast' &&
        variant.params[0]?.value.toLowerCase() === 'true',
    )
  );
}

/** Option ids shown as icons on the trigger — not text badges. */
export function isTriggerIconOption(id: string): boolean {
  return id === 'fast' || isEffortSliderOption(id);
}
