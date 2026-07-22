import type { ModelOptionDescriptor } from '@nuncio/core/model-options';
import { modelSupportsFast } from '@nuncio/core/model-effort-options';

/**
 * Descriptors shown in the home-composer Options sheet.
 *
 * Some Codex/Cursor models expose `fast` (Priority) only as a variant, not as
 * an options descriptor — synthesize a boolean toggle so the picker can set it,
 * matching the web (which derives fast from variants).
 */
export function composerModelOptionDescriptors(model: {
  options?: ModelOptionDescriptor[];
  variants?: Array<{ params: Array<{ id: string; value: string }> }>;
} | null | undefined): ModelOptionDescriptor[] {
  const base = model?.options ?? [];
  if (model && !base.some((d) => d.id === 'fast') && modelSupportsFast(model)) {
    return [...base, { id: 'fast', label: 'Priority', type: 'boolean', defaultValue: false }];
  }
  return base;
}
